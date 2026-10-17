import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditLogger } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import { PathGuard } from "../src/guard.js";
import { ProcessManager } from "../src/process.js";
import { ExecutionScheduler } from "../src/scheduler.js";
import { registerTools } from "../src/tools.js";

test("real background process transfers ownership after spawn and does not retain scheduler claims", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-background-scheduler-"));
  const root = path.join(temporary, "workspace"), other = path.join(temporary, "other");
  const readRoot = path.join(temporary, "read-workspace");
  await Promise.all([mkdir(root), mkdir(other), mkdir(readRoot)]);
  const guard = await PathGuard.create([root, other, readRoot], false);
  const config = {
    roots: [root, other, readRoot], auth: { mode: "none" },
    shell: { allowedCommands: ["node", "missing-lc-background-command"], maxTimeoutMs: 3000, maxOutputBytes: 1024, maxProcesses: 2 },
    files: { maxReadBytes: 1024, maxWriteBytes: 1024, maxSearchFileBytes: 1024, allowSensitiveFiles: false }
  } as AppConfig;
  const processes = new ProcessManager(config, guard);
  const scheduler = new ExecutionScheduler({ read: 2, general: 1, cpu: 1, wait: 1 }, guard);
  type Response = { isError?: boolean; content: Array<{ text: string }> };
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Response>>();
  const server = { registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<Response>) { handlers.set(name, handler); } };
  let requestId = 0;
  const audit = { start: async () => ({ id: ++requestId, startedAt: Date.now() }), finish: async () => {}, fail: async () => {} };
  registerTools(server as unknown as McpServer, config, guard, processes, audit as unknown as AuditLogger, scheduler);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await handlers.get(name)!(args);
    assert.notEqual(result.isError, true, result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  };

  let responseTimer: NodeJS.Timeout | undefined;
  try {
    const started = await Promise.race([
      call("process_start", { command: "node", args: ["-e", "console.log('ready');setInterval(()=>{},1000)"], cwd: root }),
      new Promise<never>((_, reject) => { responseTimer = setTimeout(() => reject(Error("start response waited for process exit")), 3000); })
    ]);
    clearTimeout(responseTimer);
    assert.equal(started.running, true);

    await Promise.all([
      call("fs_write", { path: path.join(root, "while-running.txt"), content: "while running", overwrite: true }),
      call("command_run", { command: "node", args: ["-e", "console.log('same-root')"], cwd: root }),
      call("command_run", { command: "node", args: ["-e", "console.log('other-root')"], cwd: other }),
      call("fs_list", { path: readRoot, depth: 1, maxEntries: 10 })
    ]);

    assert.equal(await readFile(path.join(root, "while-running.txt"), "utf8"), "while running");
    const status = await call("scheduler_status");
    assert.equal(status.active.general, 0);
    assert.equal(status.queued.length, 0);
    assert.equal(status.locks.length, 0);
    assert.equal(status.workers.busy, 0);
    assert.ok(status.workers.idle >= 2);
    assert.equal((await call("process_list"))[0].id, started.id);
    assert.equal((await call("process_output", { id: started.id, tailChars: 100 })).running, true);

    assert.equal((await call("process_kill", { id: started.id })).killConfirmed, true);

    const missing = await call("process_start", { command: "missing-lc-background-command", args: [], cwd: root });
    await processes.waitForClose(missing.id);
    await call("fs_write", { path: path.join(root, "recovered.txt"), content: "recovered", overwrite: true });
    assert.equal((await call("process_output", { id: missing.id })).running, false);
  } finally {
    clearTimeout(responseTimer);
    await processes.killAll();
    await rm(temporary, { recursive: true, force: true });
  }
});
