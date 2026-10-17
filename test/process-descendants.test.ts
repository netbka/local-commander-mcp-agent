import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { PathGuard } from "../src/guard.js";
import { ProcessManager, runCommand } from "../src/process.js";
import { selectDescendants } from "../src/process-tree.js";

const windows = { skip: process.platform !== "win32" };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("descendant selection follows only newer children of a possibly dead root", () => {
  const rows = [
    { pid: 10, parent: 1, created: 1000 },
    { pid: 11, parent: 10, created: 1100 },
    { pid: 12, parent: 11, created: 1200 },
    { pid: 13, parent: 10, created: 500 },
    { pid: 14, parent: 99, created: 1300 },
    { pid: 15, parent: 10, created: 1400 }
  ];
  assert.deepEqual(selectDescendants(rows, 10, 1000, 15).sort(), [11, 12]);
  assert.deepEqual(selectDescendants(rows, 50, 0), []);
});

test("detached descendants holding output neither hang commands nor survive", windows, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-descendants-"));
  try {
    const config: AppConfig = {
      roots: [root], server: { host: "127.0.0.1", port: 17321, mcpPath: "/mcp" },
      auth: { mode: "none", oauthStatePath: path.join(root, "o.json"), accessTokenTtlSec: 1, refreshTokenTtlSec: 1, authorizationCodeTtlSec: 1, approvalCodeTtlSec: 1 },
      files: { maxReadBytes: 1024, maxWriteBytes: 1024, maxSearchFileBytes: 1024, allowSensitiveFiles: false },
      shell: { allowedCommands: ["node"], maxTimeoutMs: 40_000, maxOutputBytes: 65_536, maxProcesses: 4 },
      http: { allowedHosts: ["127.0.0.1"], maxResponseBytes: 1024, timeoutMs: 1000 }
    };
    const guard = await PathGuard.create([root], false);
    await writeFile(path.join(root, "holder.cjs"), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
    await writeFile(path.join(root, "parent.cjs"), [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, [require('path').join(__dirname, 'holder.cjs'), require('path').join(__dirname, process.argv[2])], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "child.unref();",
      "const fs = require('fs'); const marker = require('path').join(__dirname, process.argv[2]);",
      "const wait = setInterval(() => { if (fs.existsSync(marker)) { console.log('parent-done'); process.exit(process.argv[3] === 'fail' ? 3 : 0); } }, 25);"
    ].join("\n"));

    await t.test("run_command returns after the process exits and removes the holder", async () => {
      const started = Date.now();
      const result = await runCommand(config, guard, { command: "node", args: ["parent.cjs", "run.pid"], cwd: root, timeoutMs: 35_000 });
      assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false); assert.equal(result.descendantsHeldOutput, true);
      assert.match(result.stdout, /parent-done/); assert.ok(Date.now() - started < 25_000);
      const pid = Number(await readFile(path.join(root, "run.pid"), "utf8"));
      await waitFor(async () => (alive(pid) ? undefined : true));
    });

    await t.test("a managed process that exited but still holds pipes can be killed and closes", async () => {
      const manager = new ProcessManager(config, guard);
      const started = await manager.start({ command: "node", args: ["parent.cjs", "managed.pid", "fail"], cwd: root });
      const pid = Number(await waitFor(async () => (await readFile(path.join(root, "managed.pid"), "utf8")) || undefined));
      await waitFor(async () => ((manager.output(started.id).output as string).includes("parent-done") ? true : undefined));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(alive(pid), true);
      assert.equal(manager.list().find((item) => item.id === started.id)?.running, true, "lifetime stays held until pipes close");
      await manager.kill(started.id);
      await waitFor(async () => (alive(pid) ? undefined : true));
      await Promise.race([manager.waitForClose(started.id), new Promise((_, reject) => setTimeout(() => reject(new Error("never closed")), 30_000))]);
    });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
