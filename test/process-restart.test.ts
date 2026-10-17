import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../src/config.js";
import { PathGuard } from "../src/guard.js";
import { ProcessManager } from "../src/process.js";
import { ProcessRegistry } from "../src/process-registry.js";

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

function configFor(root: string): AppConfig {
  return {
    roots: [root], server: { host: "127.0.0.1", port: 17321, mcpPath: "/mcp" },
    auth: { mode: "none", oauthStatePath: path.join(root, "oauth.json"), accessTokenTtlSec: 1, refreshTokenTtlSec: 1, authorizationCodeTtlSec: 1, approvalCodeTtlSec: 1 },
    files: { maxReadBytes: 1024, maxWriteBytes: 1024, maxSearchFileBytes: 1024, allowSensitiveFiles: false },
    shell: { allowedCommands: ["node"], maxTimeoutMs: 20_000, maxOutputBytes: 65_536, maxProcesses: 4 },
    http: { allowedHosts: ["127.0.0.1"], maxResponseBytes: 1024, timeoutMs: 1000 }
  };
}

test("the registry records active roots atomically and drops finished ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-registry-"));
  try {
    const file = path.join(root, "nested", "processes.json");
    const registry = new ProcessRegistry(file);
    assert.deepEqual(await registry.load(), []);
    registry.add("1", { pid: 41, startedAtMs: 1000 }); registry.add("2", { pid: 42, startedAtMs: 2000 });
    registry.remove("1"); await registry.flush();
    assert.deepEqual(await registry.load(), [{ pid: 42, startedAtMs: 2000 }]);
    registry.remove("2"); await registry.flush();
    assert.deepEqual(await registry.load(), []);
    await writeFile(file, "not json"); assert.deepEqual(await registry.load(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a restarted server reclaims a detached process left by a crashed one", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-restart-"));
  try {
    await writeFile(path.join(root, "holder.cjs"), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
    await writeFile(path.join(root, "launcher.cjs"), [
      "const { spawn } = require('child_process'); const path = require('path');",
      "spawn(process.execPath, [path.join(__dirname, 'holder.cjs'), path.join(__dirname, 'holder.pid')], { detached: true, stdio: 'ignore' }).unref();",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    const managerUrl = pathToFileURL(path.resolve("src/process.ts")).href, guardUrl = pathToFileURL(path.resolve("src/guard.ts")).href;
    await writeFile(path.join(root, "crash.mts"), [
      `import { ProcessManager } from ${JSON.stringify(managerUrl)}; import { PathGuard } from ${JSON.stringify(guardUrl)};`,
      `const root = ${JSON.stringify(root)}; const guard = await PathGuard.create([root], false);`,
      `const config = ${JSON.stringify(configFor(root))};`,
      "const manager = new ProcessManager(config as never, guard);",
      "await manager.start({ command: 'node', args: ['launcher.cjs'], cwd: root });",
      "await new Promise((resolve) => setTimeout(resolve, 1500)); process.exit(1);"
    ].join("\n"));
    const server = spawn(process.execPath, ["--import", "tsx", path.join(root, "crash.mts")], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => server.once("close", resolve));
    const holder = Number(await waitFor(async () => (await readFile(path.join(root, "holder.pid"), "utf8")) || undefined));
    assert.equal(alive(holder), true, "the detached descendant survives the crashed server");

    const restarted = new ProcessManager(configFor(root), await PathGuard.create([root], false));
    assert.ok(await restarted.reclaimOrphans() >= 1);
    await waitFor(async () => (alive(holder) ? undefined : true));
    assert.equal(await restarted.reclaimOrphans(), 0);
  } finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
});
