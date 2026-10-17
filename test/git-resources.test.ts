import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildChildEnvironment } from "../src/child-environment.js";
import { PathGuard } from "../src/guard.js";
import { gitResourcePaths } from "../src/git-resources.js";
import { ExecutionScheduler } from "../src/scheduler.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, {
  cwd, windowsHide: true, timeout: 10000, env: buildChildEnvironment(process.env, process.platform)
});

test("real linked worktrees share metadata claims across commands, inspections and background starts", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-git-resources-"));
  const main = path.join(temporary, "main"), linked = path.join(temporary, "linked"), other = path.join(temporary, "other");
  try {
    await Promise.all([mkdir(main), mkdir(other)]);
    await git(main, "init");
    await git(main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "commit", "--allow-empty", "-m", "fixture");
    await git(main, "worktree", "add", "--detach", linked);
    await git(other, "init");
    const guard = await PathGuard.create([main, linked, other], false);
    const common = await realpath((await git(linked, "rev-parse", "--path-format=absolute", "--git-common-dir")).stdout.trim());
    assert.ok((await gitResourcePaths(guard, linked)).includes(common));
    assert.ok((await gitResourcePaths(guard, linked, ["--git-dir=.git"])).includes(common));
    for (const tool of ["command_run", "process_start"]) {
      const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 4, cpu: 4 }, guard);
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const accepted = new Promise<void>(resolve => { started = resolve; });
      const events: string[] = [];
      const first = scheduler.run(1, tool, { command: "git", cwd: linked }, async () => { events.push("linked"); started(); await gate; events.push("released"); });
      await accepted;
      const later = [
        scheduler.run(2, "git_status", { path: main }, () => { events.push("main-read"); }),
        scheduler.run(3, "command_run", { command: "git", cwd: main }, () => { events.push("main-write"); }),
        scheduler.run(4, "fs_write", { path: path.join(main, ".git", "config") }, () => { events.push("metadata-write"); })
      ];
      try {
        await scheduler.run(5, "git_status", { path: other }, () => { events.push("independent"); });
        assert.deepEqual(events, ["linked", "independent"]);
      } finally { release(); await Promise.all([first, ...later]); }
      assert.ok(events.indexOf("released") < events.indexOf("main-read"));
    }
    const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 4, cpu: 4 }, guard);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { started = resolve; });
    const first = scheduler.run(1, "git_status", { path: main }, async () => { started(); await gate; });
    await accepted;
    try { assert.equal(await scheduler.run(2, "git_log", { path: linked }, () => "overlapped"), "overlapped"); }
    finally { release(); await first; }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Git global target options match real Git path resolution and serialize the redirected repository", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-git-targets-"));
  const source = path.join(temporary, "source"), target = path.join(temporary, "target");
  try {
    await Promise.all([mkdir(source), mkdir(path.join(target, "nested"), { recursive: true })]);
    await git(target, "init");
    await git(source, "init", "--bare");
    await symlink(path.join(target, "nested"), path.join(source, "alias"), process.platform === "win32" ? "junction" : "dir");
    const guard = await PathGuard.create([source, target], false);
    const options = [
      ["-C", "../target"], ["-C", "../target", "-C", "nested", "-C", ""],
      ["--no-pager", "-c", "color.ui=false", "-C", target],
      ["--git-dir=../target/.git", "--work-tree=../target"],
      ["--git-dir", ".git", "--work-tree", ".", "-C", target],
      ["--git-dir=.git", "--work-tree=.", "-C", target],
      [], ["--bare"], ["--bare", "-C", target], ["--bare", "--git-dir=../target/.git"],
      ["--git-dir=../target/.git", "--bare"]
    ];
    for (const args of options) {
      const paths = await gitResourcePaths(guard, source, [...args, "rev-parse", "--absolute-git-dir"]);
      const actual = await realpath((await git(source, ...args, "rev-parse", "--absolute-git-dir")).stdout.trim());
      assert.ok(paths.some(filename => guard.isWithin(filename, actual) && guard.isWithin(actual, filename)), JSON.stringify({ args, actual, paths }));
    }
    const actualWorktree = await realpath((await git(source, "--git-dir=.git", "--work-tree=.", "-C", target, "rev-parse", "--show-toplevel")).stdout.trim());
    assert.ok((await gitResourcePaths(guard, source, ["--git-dir=.git", "--work-tree=.", "-C", target, "status"])).includes(actualWorktree));
    await assert.rejects(gitResourcePaths(guard, source, ["-C", "alias", "-C", ".."]), /GIT_TARGET_AMBIGUOUS/);
    await assert.rejects(gitResourcePaths(guard, source, ["-C", "alias/.."]), /GIT_TARGET_AMBIGUOUS/);
    const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 4, cpu: 4 }, guard);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { started = resolve; });
    const first = scheduler.run(1, "command_run", { command: " GIT.exe ", cwd: source, args: ["-C", target, "status"] }, async () => { started(); await gate; });
    await accepted;
    let ran = false;
    const reader = scheduler.run(2, "git_status", { path: target }, () => { ran = true; });
    try {
      await scheduler.run(3, "localhost_request", { url: "http://localhost", method: "GET" }, () => undefined);
      assert.equal(ran, false);
    } finally { release(); await Promise.all([first, reader]); }
    assert.equal(ran, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Git metadata and redirect admission reject unapproved, malformed and dangling targets", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-git-boundary-"));
  const root = path.join(temporary, "root"), outside = path.join(temporary, "outside");
  try {
    await Promise.all([mkdir(root), mkdir(outside)]);
    const guard = await PathGuard.create([root], false);
    const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 4, cpu: 4 }, guard);
    let ran = false;
    for (const args of [["-C", outside], ["--git-dir=" + outside], ["--work-tree=" + outside], ["-C"], ["--git-dir="], ["--work-tree"]]) {
      await assert.rejects(scheduler.run(1, "command_run", { command: "git", cwd: root, args }, () => { ran = true; }));
    }
    for (const contents of ["gitdir: " + outside, "gitdir: missing", "not a gitfile", "gitdir: \n", "x".repeat(4097)]) {
      await writeFile(path.join(root, ".git"), contents);
      await assert.rejects(scheduler.run(2, "git_status", { path: root }, () => { ran = true; }));
    }
    await rm(path.join(root, ".git"));
    await mkdir(path.join(root, ".git"));
    for (const contents of [outside, "missing", "\n", "x\ny", "x".repeat(4097)]) {
      await writeFile(path.join(root, ".git", "commondir"), contents);
      await assert.rejects(scheduler.run(3, "process_start", { command: "git", cwd: root }, () => { ran = true; }));
    }
    assert.equal(ran, false);
    await rm(path.join(root, ".git", "commondir"));
    assert.equal(await scheduler.run(4, "git_status", { path: root }, () => "recovered"), "recovered");
    await symlink(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(gitResourcePaths(guard, root, ["-C", "alias"]), /outside configured roots/);
    const protectedGuard = await PathGuard.create([root, outside], false, { protectedPaths: [outside] });
    await writeFile(path.join(root, ".git", "commondir"), outside);
    await assert.rejects(gitResourcePaths(protectedGuard, root), /Protected path access/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
