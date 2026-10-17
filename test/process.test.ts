import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { PathGuard } from "../src/guard.js";
import { ProcessManager, resolveWindowsLauncher, runCommand } from "../src/process.js";

function config(root: string, overrides: Partial<AppConfig["shell"]> = {}): AppConfig {
  return {
    roots: [root],
    server: { host: "127.0.0.1", port: 17321, mcpPath: "/mcp" },
    auth: {
      mode: "none",
      oauthStatePath: path.join(root, "oauth.json"),
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 3600,
      authorizationCodeTtlSec: 300,
      approvalCodeTtlSec: 300
    },
    files: {
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
      maxSearchFileBytes: 1024,
      allowSensitiveFiles: false
    },
    shell: {
      allowedCommands: ["node", "definitely-not-lcmcp-command"],
      maxTimeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      maxProcesses: 2,
      ...overrides
    },
    http: { allowedHosts: ["127.0.0.1"], maxResponseBytes: 1024, timeoutMs: 1000 }
  };
}

function fakeGuard(root: string, resolveDirectory: (input: string) => Promise<string>): PathGuard {
  return {
    roots: [root],
    resolveDirectory,
    resolveExisting: async (input: string) => path.resolve(root, input),
    resolveForWrite: async (input: string) => path.resolve(root, input),
    assertSafeFile: () => undefined,
    isWithin: () => true
  } as unknown as PathGuard;
}

test("ProcessManager reserves maxProcesses synchronously before delayed cwd lookup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-process-"));
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actualGuard = await PathGuard.create([root], false);
  let resolvedLookups = 0;
  const manager = new ProcessManager(
    config(root, { maxProcesses: 2 }),
    fakeGuard(root, async () => {
      await blocker;
      resolvedLookups++;
      return actualGuard.resolveDirectory(root);
    })
  );

  try {
    const starts = Array.from({ length: 30 }, () =>
      manager.start({ command: "node", args: ["-e", "setTimeout(() => {}, 2000)"], cwd: root })
    );
    release();
    const settled = await Promise.allSettled(starts);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");

    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 28);
    assert.equal(resolvedLookups, 2, "only admitted requests reach real async path resolution");
    await manager.killAll();
  } finally {
    await manager.killAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("ProcessManager releases pending slot when cwd validation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-process-"));
  let calls = 0;
  const manager = new ProcessManager(
    config(root, { maxProcesses: 1 }),
    fakeGuard(root, async () => {
      calls += 1;
      if (calls === 1) throw new Error("bad cwd");
      return root;
    })
  );

  try {
    await assert.rejects(
      manager.start({ command: "node", args: ["-e", "setTimeout(() => {}, 1000)"], cwd: "missing" }),
      /bad cwd/
    );
    const admitted = await manager.start({ command: "node", args: ["-e", "setTimeout(() => {}, 1000)"], cwd: "." });
    assert.equal(admitted.command, "node");
    await manager.killAll();
  } finally {
    await manager.killAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("ProcessManager command launch error does not occupy capacity forever", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-process-"));
  const manager = new ProcessManager(config(root, { maxProcesses: 1 }), fakeGuard(root, async () => root));

  try {
    // An allowlisted name that is not on PATH is refused before spawn (cwd is never searched) and must release its slot.
    await assert.rejects(manager.start({ command: "definitely-not-lcmcp-command", args: [] }), /not found in an absolute PATH directory/);
    assert.ok(manager.list().every((item) => item.running === false));
    const admitted = await manager.start({ command: "node", args: ["-e", "setTimeout(() => {}, 1000)"] });
    assert.equal(admitted.command, "node");
    await manager.killAll();
  } finally {
    await manager.killAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand closes stdin and uses sanitized child environment for actual node command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-process-"));
  const oldToken = process.env.LCMCP_TOKEN;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  process.env.LCMCP_TOKEN = "should-not-leak";
  process.env.NODE_OPTIONS = "--definitely-not-a-real-node-option-for-child";

  try {
    const result = await runCommand(config(root), fakeGuard(root, async () => root), {
      command: "node",
      args: [
        "-e",
        "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.stringify({ eof: true, data, leaked: Boolean(process.env.LCMCP_TOKEN), nodeOptions: process.env.NODE_OPTIONS || '' })));"
      ],
      cwd: root,
      timeoutMs: 2_000
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim()) as { eof: boolean; data: string; leaked: boolean; nodeOptions: string };
    assert.equal(parsed.eof, true);
    assert.equal(parsed.data, "");
    assert.equal(parsed.leaked, false);
    assert.equal(parsed.nodeOptions, "");
  } finally {
    if (oldToken === undefined) delete process.env.LCMCP_TOKEN;
    else process.env.LCMCP_TOKEN = oldToken;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
    await rm(root, { recursive: true, force: true });
  }
});

const windowsOnly = { skip: process.platform !== "win32" ? "Windows launcher resolution" : false };

test("resolveWindowsLauncher takes the first PATH match in PATHEXT order", windowsOnly, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-launcher-"));
  try {
    const shims = path.join(root, "shims");
    const native = path.join(root, "native dir");
    await mkdir(shims);
    await mkdir(native);
    await writeFile(path.join(shims, "codex.cmd"), "");
    await writeFile(path.join(native, "codex.exe"), "");
    await writeFile(path.join(native, "agent.exe"), "");
    await writeFile(path.join(native, "agent.cmd"), "");
    await mkdir(path.join(native, "claude.exe"));
    const env = { PATH: `relative;"${shims}";${native}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" };

    assert.deepEqual(resolveWindowsLauncher("codex", env), { file: path.join(shims, "codex.cmd"), shell: true });
    assert.deepEqual(resolveWindowsLauncher("agent", env), { file: path.join(native, "agent.exe"), shell: false });
    assert.equal(resolveWindowsLauncher("claude", env), undefined);
    assert.equal(resolveWindowsLauncher("codex", { ...env, PATHEXT: ".PS1" }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand launches a PATH .cmd agent shim with arguments intact and rejects cmd metacharacters", windowsOnly, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-agent-shim-"));
  const oldPath = process.env.PATH;
  try {
    const bin = path.join(root, "bin dir");
    await mkdir(bin);
    await writeFile(path.join(bin, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(path.join(bin, "codex.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    // A same-named shim in the cwd must not shadow the PATH entry.
    await writeFile(path.join(root, "codex.cmd"), "@ECHO cwd-shim\r\n");
    process.env.PATH = `${bin};${oldPath ?? ""}`;
    const shellConfig = config(root, { allowedCommands: ["codex"] });
    const guard = fakeGuard(root, async () => root);

    const args = ["exec", "fix the bug", 'say "hi" (now)', "", "C:\\dir with space\\", "a=b,c;d", "tab\there"];
    const result = await runCommand(shellConfig, guard, { command: "codex", args, cwd: root, timeoutMs: 5_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);

    await assert.rejects(
      runCommand(shellConfig, guard, { command: "codex", args: ["exec", "x & calc"], cwd: root }),
      /cmd\.exe metacharacters/
    );
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand launches a PATH native agent executable directly without shell restrictions", windowsOnly, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-agent-exe-"));
  const oldPath = process.env.PATH;
  try {
    const agent = path.join(root, "agent.exe");
    await link(process.execPath, agent).catch(() => copyFile(process.execPath, agent));
    process.env.PATH = `${root};${oldPath ?? ""}`;
    const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "x > y & z", "100%", "line\nbreak"];
    const result = await runCommand(config(root, { allowedCommands: ["agent"] }), fakeGuard(root, async () => root), {
      command: "agent",
      args,
      cwd: root,
      timeoutMs: 5_000
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args.slice(2));
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("ProcessManager closes stdin for agent CLIs and keeps it open for other processes", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-agent-stdin-"));
  const oldPath = process.env.PATH;
  const manager = new ProcessManager(
    config(root, { allowedCommands: ["node", "agent"] }),
    fakeGuard(root, async () => root)
  );
  try {
    const agent = path.join(root, process.platform === "win32" ? "agent.exe" : "agent");
    await link(process.execPath, agent).catch(() => copyFile(process.execPath, agent));
    process.env.PATH = `${root}${path.delimiter}${oldPath ?? ""}`;
    const script = "process.stdin.on('end', () => console.log('stdin-eof')).resume()";

    const agentRun = await manager.start({ command: "agent", args: ["-e", script], cwd: root });
    const other = await manager.start({ command: "node", args: ["-e", script], cwd: root });
    await manager.waitForClose(agentRun.id);
    const agentOutput = manager.output(agentRun.id);
    assert.equal(agentOutput.exitCode, 0, String(agentOutput.output));
    assert.match(String(agentOutput.output), /stdin-eof/);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const otherOutput = manager.output(other.id);
    assert.equal(otherOutput.running, true);
    assert.doesNotMatch(String(otherOutput.output), /stdin-eof/);
  } finally {
    await manager.killAll().catch(() => undefined);
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("managed output preserves split stream decoding and bounded newest tail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-output-live-"));
  const guard = await PathGuard.create([root], false);
  const manager = new ProcessManager(config(root, { maxOutputBytes: 16 }), guard);
  try {
    const code = "process.stdout.write('x'.repeat(100000));process.stdout.write(Buffer.from([0xE2]));process.stderr.write('E');setTimeout(()=>{process.stdout.write(Buffer.from([0x82,0xAC]));process.stderr.write('😀');},30)";
    const job = await manager.start({ command: "node", args: ["-e", code], cwd: root });
    await manager.waitForClose(job.id);
    await manager.waitForClose(job.id); // Already-closed records remain awaitable after the event.
    const out = manager.output(String(job.id), 200);
    assert.equal(out.outputTruncated, true);
    assert.ok(Buffer.byteLength(String(out.output)) <= 16);
    assert.ok(String(out.output).includes("€"));
    assert.ok(!String(out.output).includes("�"));
    assert.equal(/[\uD800-\uDFFF]/.test(String(manager.output(String(job.id), 1).output)), false);
  } finally { await manager.killAll(); await rm(root, { recursive: true, force: true }); }
});

test("ProcessManager does not spend the exit-confirmation window while issuing the kill", windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lcmcp-kill-confirm-"));
  const manager = new ProcessManager(config(root), await PathGuard.create([root], false));
  try {
    const job = await manager.start({ command: "node", args: ["-e", "setInterval(() => {}, 1000)"], cwd: root });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const killing = manager.kill(job.id);
    // taskkill is still asynchronous; simulate a busy machine consuming the old early timer.
    t.mock.timers.tick(3_001);
    const result = await killing;
    assert.equal(result.killConfirmed, true);
    assert.equal(result.running, false);
    await manager.waitForClose(job.id);
  } finally {
    t.mock.timers.reset();
    await manager.killAll();
    await rm(root, { recursive: true, force: true });
  }
});
