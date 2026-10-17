import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("parallel_command_run admits same-workspace commands in batch order even when audit starts finish out of order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lc-parallel-order-"));
  const guard = await PathGuard.create([root], false);
  const config = {
    roots: [root], auth: { mode: "none" },
    shell: { allowedCommands: ["node"], maxTimeoutMs: 10_000, maxOutputBytes: 4096, maxProcesses: 4 },
    files: { maxReadBytes: 1024, maxWriteBytes: 1024, maxSearchFileBytes: 1024, allowSensitiveFiles: false }
  } as AppConfig;
  const processes = new ProcessManager(config, guard);
  const scheduler = new ExecutionScheduler(undefined, guard);
  // A real audit file append can complete in any order; make later calls finish first.
  let requestId = 0;
  const audit = {
    start: async () => {
      const id = ++requestId;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 90 - id * 30)));
      return { id, startedAt: Date.now() };
    },
    finish: async () => {},
    fail: async () => {}
  };
  type Response = { isError?: boolean; content: Array<{ text: string }> };
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Response>>();
  const server = { registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<Response>) { handlers.set(name, handler); } };
  registerTools(server as unknown as McpServer, config, guard, processes, audit as unknown as AuditLogger, scheduler);

  try {
    const response = await handlers.get("parallel_command_run")!({
      commands: [
        { id: "write", command: "node", args: ["-e", "setTimeout(()=>require('node:fs').writeFileSync('ordered.txt','first finished'),150)"], cwd: root, timeoutMs: 5000 },
        { id: "read", command: "node", args: ["-e", "console.log(require('node:fs').readFileSync('ordered.txt','utf8'))"], cwd: root, timeoutMs: 5000 }
      ]
    });
    assert.notEqual(response.isError, true, response.content[0]!.text);
    const batch = JSON.parse(response.content[0]!.text);
    assert.deepEqual(batch.results.map((item: { id: string }) => item.id), ["write", "read"]);
    assert.equal(batch.failed, 0, JSON.stringify(batch.results.map((item: { id: string; ok: boolean; stderr?: string }) => ({ id: item.id, ok: item.ok, stderr: item.stderr?.split("\n")[0] }))));
    assert.equal(batch.results[1].stdout.trim(), "first finished");
  } finally {
    await processes.killAll();
    await rm(root, { recursive: true, force: true });
  }
});
