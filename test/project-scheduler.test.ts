import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildChildEnvironment } from "../src/child-environment.js";
import { PathGuard } from "../src/guard.js";
import { ExecutionScheduler } from "../src/scheduler.js";
import { readRpcResponse, rpcEnvelope, rpcHeaders } from "./helpers/mcp-wire.js";

const exec = promisify(execFile);
async function init(cwd: string): Promise<void> {
  await exec("git", ["init", "--quiet"], { cwd, windowsHide: true, timeout: 10000,
    env: buildChildEnvironment(process.env, process.platform) });
}
const limits = { read: 4, general: 4, wait: 4, cpu: 4 };

test("one broad approval permits independent repositories and non-overlapping sibling files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-project-scope-"));
  const a = path.join(temporary, "project-a"), b = path.join(temporary, "project-b");
  const nested = path.join(a, "src");
  try {
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(b)]);
    await Promise.all([init(a), init(b)]);
    for (const roots of [[temporary], [nested, temporary, a], [a, temporary, nested]]) {
      const guard = await PathGuard.create(roots, false);
      for (const tool of ["command_run", "process_start"]) {
        const scheduler = new ExecutionScheduler(limits, guard);
        let release!: () => void, accepted!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { accepted = resolve; });
        const first = scheduler.run(1, tool, { command: "node", cwd: nested }, async () => { accepted(); await gate; });
        await started;
        let siblingRan = false;
        const sibling = scheduler.run(2, "fs_write", { path: path.join(a, "sibling.txt") }, () => { siblingRan = true; });
        try {
          const value = await scheduler.run(3, "command_run", { command: "node", cwd: b }, () => "independent", { queueTimeoutMs: 500 });
          assert.equal(value, "independent");
          assert.equal(siblingRan, true, "ordinary command/process admission is not a repository-wide file mutex");
          const broad = "repo:" + (process.platform === "win32" ? (await realpath(temporary)).toLowerCase() : await realpath(temporary));
          assert.ok(!(scheduler.snapshot().locks as Array<{ key: string }>).some(lock => lock.key === broad));
        } finally { release(); await Promise.all([first, sibling]); }
        assert.equal(siblingRan, true);
        assert.deepEqual(scheduler.snapshot().locks, []);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("non-Git commands lock their canonical cwd, not every approved sibling", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-nongit-scope-"));
  const a = path.join(temporary, "a"), b = path.join(temporary, "b");
  try {
    const nested = path.join(a, "nested");
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(b)]);
    const guard = await PathGuard.create([temporary], false);
    const scheduler = new ExecutionScheduler(limits, guard);
    let release!: () => void, accepted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { accepted = resolve; });
    const first = scheduler.run(1, "command_run", { command: "node", cwd: a }, async () => { accepted(); await gate; });
    await started;
    try {
      assert.equal(await scheduler.run(2, "fs_write", { path: path.join(b, "ok.txt") }, () => "ok", { queueTimeoutMs: 500 }), "ok");
      assert.equal(await scheduler.run(3, "command_run", { command: "node", cwd: nested }, () => "nested", { queueTimeoutMs: 500 }), "nested");
    } finally { release(); await first; }
    // An omitted cwd still targets the configured root for execution, but command execution
    // no longer becomes a global filesystem mutex for every agent under that approved root.
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("ordinary commands in linked worktrees do not claim the shared Git commondir", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-linked-worktree-"));
  const primary = path.join(temporary, "primary"), linked = path.join(temporary, "linked");
  try {
    await mkdir(primary, { recursive: true });
    await init(primary);
    await exec("git", ["config", "user.email", "test@example.test"], { cwd: primary, windowsHide: true, env: buildChildEnvironment(process.env, process.platform) });
    await exec("git", ["config", "user.name", "Local Commander Test"], { cwd: primary, windowsHide: true, env: buildChildEnvironment(process.env, process.platform) });
    await writeFile(path.join(primary, "seed.txt"), "seed");
    await exec("git", ["add", "seed.txt"], { cwd: primary, windowsHide: true, env: buildChildEnvironment(process.env, process.platform) });
    await exec("git", ["commit", "-m", "seed", "--quiet"], { cwd: primary, windowsHide: true, env: buildChildEnvironment(process.env, process.platform) });
    await exec("git", ["worktree", "add", "-b", "linked-test", linked, "--quiet"], { cwd: primary, windowsHide: true, env: buildChildEnvironment(process.env, process.platform) });
    const guard = await PathGuard.create([temporary], false);
    const scheduler = new ExecutionScheduler(limits, guard);
    let release!: () => void, accepted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { accepted = resolve; });
    const first = scheduler.run(1, "command_run", { command: "node", cwd: primary }, async () => { accepted(); await gate; });
    await started;
    try {
      assert.equal(await scheduler.run(2, "command_run", { command: "node", cwd: linked }, () => "parallel", { queueTimeoutMs: 500 }), "parallel");
      // Git common-directory fencing is covered separately by the existing scheduler Git tests.
    } finally { release(); await first; }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

async function port(): Promise<number> {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("PROJECT_FIXTURE_NOT_READY");
}

test("real authenticated MCP overlaps separate-project commands and detaches managed-process locks", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lc-project-mcp-"));
  const root = path.join(dir, "approved"), a = path.join(root, "a"), b = path.join(root, "b");
  await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })]);
  await Promise.all([init(a), init(b)]);
  const token = randomBytes(32).toString("base64url"), base = `http://127.0.0.1:${await port()}`;
  const settings = path.join(dir, "settings.json");
  await writeFile(settings, JSON.stringify({ roots: [root], server: { host: "127.0.0.1", port: Number(new URL(base).port) },
    auth: { mode: "bearer", token, publicBaseUrl: "https://public.example.test", allowedOrigins: ["https://chat.example.test"], oauthStatePath: path.join(dir, "oauth.json") },
    shell: { allowedCommands: ["node"], maxTimeoutMs: 10000, maxProcesses: 2 } }), { mode: 0o600 });
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: project, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], env: { ...buildChildEnvironment(process.env), DOTENV_CONFIG_PATH: path.join(dir, "not-present.env"),
      LCMCP_CONFIG: settings, LCMCP_LOG_LEVEL: "off", LCMCP_AUDIT_LOG: path.join(dir, "audit.jsonl") } });
  child.stdin.end(); child.stdout.resume(); child.stderr.resume(); const closed = once(child, "close");
  let requestId = 0, managedId: string | undefined;
  const pending: Promise<unknown>[] = [];
  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const id = ++requestId;
    const response = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders("tools/call", name), authorization: `Bearer ${token}` },
      body: JSON.stringify(rpcEnvelope(id, "tools/call", { name, arguments: args })), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const reply = await readRpcResponse(response, id);
    assert.equal(reply.error, undefined);
    assert.ok(reply.result); assert.notEqual(reply.result.isError, true, name + " must succeed");
    const text = (reply.result.content as Array<{ text?: string }>).find(block => typeof block.text === "string")?.text;
    assert.ok(text); return JSON.parse(text);
  }
  try {
    await waitUntil(async () => { try { return (await fetch(base + "/health", { signal: AbortSignal.timeout(200) })).ok; } catch { return false; } }, 5000);
    const first = call("command_run", { command: "node", cwd: a, timeoutMs: 10000,
      args: ["-e", "const fs=require('fs');fs.writeFileSync('ready.txt','ready');const timer=setInterval(()=>{if(fs.existsSync('release.txt')){clearInterval(timer);console.log('released')}},20)"] });
    pending.push(first); void first.catch(() => {});
    await waitUntil(async () => { try { return (await stat(path.join(a, "ready.txt"))).isFile(); } catch { return false; } }, 5000);
    let sameDone = false;
    const same = call("fs_read", { path: path.join(a, "ready.txt") }).then(value => { sameDone = true; return value; });
    pending.push(same); void same.catch(() => {});
    const independent = await call("command_run", { command: "node", cwd: b, args: ["-e", "console.log('independent')"] });
    assert.equal(independent.exitCode, 0); assert.match(independent.stdout, /independent/);
    assert.equal(sameDone, false, "same-directory read remains fenced by the active command cwd");
    assert.equal((await call("scheduler_status")).workers.busy, 1);
    await writeFile(path.join(a, "release.txt"), "release");
    await Promise.all([first, same]); assert.equal(sameDone, true);
    const started = await call("process_start", { command: "node", cwd: a, args: ["-e", "setInterval(()=>{},1000)"] });
    managedId = String(started.id);
    await call("fs_write", { path: path.join(a, "live.txt"), content: "managed child still running" });
    assert.equal((await call("command_run", { command: "node", cwd: a, args: ["-e", "console.log('same-project')"] })).exitCode, 0);
    assert.equal((await call("process_output", { id: managedId })).running, true);
    const snapshot = await call("scheduler_status");
    assert.deepEqual(snapshot.locks, []); assert.equal(snapshot.workers.busy, 0);
    assert.equal((await call("process_kill", { id: managedId })).killConfirmed, true); managedId = undefined;
  } finally {
    await writeFile(path.join(a, "release.txt"), "release").catch(() => {});
    await Promise.allSettled(pending);
    if (managedId) await call("process_kill", { id: managedId }).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
    try { await closed; } finally { clearTimeout(force); }
    await rm(dir, { recursive: true, force: true });
  }
});
