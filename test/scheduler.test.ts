import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";
import {
  ExecutionScheduler,
  defaultSchedulerLimits,
  classifyWorkload,
  resourceClaims
} from "../src/scheduler.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("scheduler defaults match the measured 20-thread workstation profile", () => {
  assert.deepEqual(defaultSchedulerLimits(20), {
    read: 24,
    wait: 32,
    general: 12,
    cpu: 12
  });
});

test("workload classification separates read, wait, cpu and general work", () => {
  assert.equal(classifyWorkload("fs_read", { path: "D:\\Work\\Project\\README.md" }), "read");
  assert.equal(
    classifyWorkload("localhost_request", { url: "http://127.0.0.1:3000/health", method: "GET" }),
    "wait"
  );
  assert.equal(
    classifyWorkload("command_run", { command: "npm", args: ["run", "build"], cwd: "D:\\Work\\Project" }),
    "cpu"
  );
  assert.equal(
    classifyWorkload("command_run", { command: "node", args: ["script.js"], cwd: "D:\\Work\\Project" }),
    "general"
  );
});

test("resource claims serialize same-file writes but allow independent files", () => {
  assert.deepEqual(resourceClaims("fs_write", { path: "D:\\Work\\Project\\a.txt" }), [
    { key: "file:d:\\work\\project\\a.txt", mode: "exclusive" }
  ]);
  assert.deepEqual(resourceClaims("fs_read", { path: "D:\\Work\\Project\\a.txt" }), [
    { key: "file:d:\\work\\project\\a.txt", mode: "shared" }
  ]);
});

test("independent read tasks actually overlap", async () => {
  const scheduler = new ExecutionScheduler({ read: 4, wait: 1, general: 1, cpu: 1 });
  const started = Date.now();

  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      scheduler.run(index + 1, "fs_read", { path: `D:\\Work\\Project\\file-${index}.txt` }, async () => {
        await sleep(80);
        return index;
      })
    )
  );

  const wall = Date.now() - started;
  assert.ok(wall < 220, `expected overlapping execution, wall=${wall}ms`);
});

test("same-file writes serialize", async () => {
  const scheduler = new ExecutionScheduler({ read: 4, wait: 4, general: 4, cpu: 4 });
  const events: string[] = [];

  await Promise.all([
    scheduler.run(1, "fs_write", { path: "D:\\Work\\Project\\same.txt" }, async () => {
      events.push("a-start");
      await sleep(70);
      events.push("a-end");
    }),
    scheduler.run(2, "fs_write", { path: "D:\\Work\\Project\\same.txt" }, async () => {
      events.push("b-start");
      await sleep(10);
      events.push("b-end");
    })
  ]);

  assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
});

test("blocked queue head does not block an independent task", async () => {
  const scheduler = new ExecutionScheduler({ read: 4, wait: 4, general: 3, cpu: 4 });
  const events: string[] = [];

  await Promise.all([
    scheduler.run(1, "fs_write", { path: "D:\\Work\\Project\\a.txt" }, async () => {
      events.push("a1-start");
      await sleep(80);
      events.push("a1-end");
    }),
    scheduler.run(2, "fs_write", { path: "D:\\Work\\Project\\a.txt" }, async () => {
      events.push("a2-start");
      await sleep(5);
      events.push("a2-end");
    }),
    scheduler.run(3, "fs_write", { path: "D:\\Work\\Project\\b.txt" }, async () => {
      events.push("b-start");
      await sleep(10);
      events.push("b-end");
    })
  ]);

  assert.ok(events.indexOf("b-start") < events.indexOf("a1-end"), events.join(", "));
  assert.ok(events.indexOf("a2-start") > events.indexOf("a1-end"), events.join(", "));
});

test("completed process startup releases its worker slot and resource claims", async () => {
  const scheduler = new ExecutionScheduler({ read: 2, wait: 1, general: 1, cpu: 1 });
  const cwd = path.resolve("managed-workspace");
  const result = await scheduler.run(1, "process_start", { command: "node", cwd }, () => ({ id: "managed" }));
  assert.equal(result.id, "managed");

  const events: string[] = [];
  await Promise.all([
    scheduler.run(2, "fs_read", { path: path.join(cwd, "same.txt") }, () => { events.push("same-workspace"); }),
    scheduler.run(3, "command_run", { command: "node", cwd: path.resolve("other-workspace") }, () => { events.push("other-workspace"); })
  ]);

  assert.deepEqual(new Set(events), new Set(["same-workspace", "other-workspace"]));
  const snapshot = scheduler.snapshot() as {
    active: { general: number };
    queued: Array<{ requestId: number }>;
    workers: { busy: number; idle: number; total: number };
    stats: { general: { completed: number } };
  };
  assert.equal(snapshot.active.general, 0);
  assert.equal(snapshot.queued.length, 0);
  assert.equal(snapshot.workers.busy, 0);
  assert.ok(snapshot.workers.idle >= 2);
  assert.equal(snapshot.stats.general.completed, 2);
});

test("scheduler snapshot exposes active and queued work", async () => {
  const scheduler = new ExecutionScheduler({ read: 1, wait: 1, general: 1, cpu: 1 });

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = scheduler.run(1, "fs_read", { path: "D:\\Work\\Project\\a.txt" }, async () => {
    await blocker;
  });
  const second = scheduler.run(2, "fs_read", { path: "D:\\Work\\Project\\b.txt" }, async () => undefined);

  await sleep(20);
  const snapshot = scheduler.snapshot() as {
    active: { read: number };
    queued: Array<{ requestId: number }>;
  };

  assert.equal(snapshot.active.read, 1);
  assert.deepEqual(snapshot.queued.map((item) => item.requestId), [2]);

  release();
  await Promise.all([first, second]);
});

test("each running operation leases one worker and the pool grows by two while busy", async () => {
  const scheduler = new ExecutionScheduler({ read: 4, wait: 1, general: 1, cpu: 1 });
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const running = [1, 2, 3].map(id =>
    scheduler.run(id, "fs_read", { path: path.resolve(`lease-workspace/${id}.txt`) }, async () => { await blocker; }));

  await sleep(20);
  type Workers = { busy: number; idle: number; total: number; workers: Array<{ state: string; requestId?: number; tool?: string }> };
  const busy = (scheduler.snapshot() as { workers: Workers }).workers;
  assert.deepEqual({ busy: busy.busy, total: busy.total }, { busy: 3, total: 4 });
  assert.deepEqual(
    busy.workers.filter(worker => worker.state === "leased").map(worker => [worker.requestId, worker.tool]).sort(),
    [[1, "fs_read"], [2, "fs_read"], [3, "fs_read"]]
  );

  release();
  await Promise.all(running);
  const idle = (scheduler.snapshot() as { workers: Workers }).workers;
  assert.deepEqual({ busy: idle.busy, idle: idle.idle }, { busy: 0, idle: 4 });
});

test("queued writers precede later conflicting readers without blocking independent work", async () => {
  for (const blockedByPool of [false, true]) {
    const scheduler = new ExecutionScheduler({ read: 4, wait: 1, general: 1, cpu: 1 });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const same = "D:\\Work\\Project\\same.txt";
    const tasks = [
      scheduler.run(1, blockedByPool ? "command_run" : "fs_read",
        blockedByPool ? { command: "node", args: ["worker.js"] } : { path: same }, async () => {
          events.push("blocker-start");
          await gate;
          events.push("blocker-end");
        }),
      scheduler.run(2, "fs_write", { path: same }, () => { events.push("writer"); }),
      scheduler.run(3, "fs_read", { path: same }, () => { events.push("later-reader"); }),
      scheduler.run(4, "fs_read", { path: "D:\\Work\\Project\\other.txt" }, () => { events.push("independent-reader"); })
    ];
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(events, ["blocker-start", "independent-reader"], `pool blocker: ${blockedByPool}`);
      const snapshot = scheduler.snapshot() as { queued: Array<{ requestId: number }> };
      assert.deepEqual(snapshot.queued.map((item) => item.requestId), [2, 3]);
    } finally {
      release();
      await Promise.all(tasks);
    }
    assert.deepEqual(events, ["blocker-start", "independent-reader", "blocker-end", "writer", "later-reader"]);
  }
});

test("queue admission is bounded, shared reads overlap and capacity recovers after saturation", async () => {
  const scheduler = new ExecutionScheduler({ read: 2, wait: 1, general: 1, cpu: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const meta = { path: "D:\\Work\\Project\\same.txt" };
  let started = 0;
  const tasks = [1, 2].map((id) => scheduler.run(id, "fs_read", meta, async () => { started++; await gate; }));
  let overflowRan = false;
  let overflowError: unknown;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, 2, "same-resource shared readers overlap");
    for (let i = 0; i < 128; i++) {
      tasks.push(scheduler.run(i + 3, "fs_read", meta, () => { started++; }));
    }
    tasks.push(scheduler.run(131, "fs_read", meta, () => { overflowRan = true; })
      .catch((error: unknown) => { overflowError = error; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(overflowError instanceof Error);
    assert.equal(overflowError.message, "SCHEDULER_QUEUE_FULL");
    const snapshot = scheduler.snapshot() as { queued: unknown[] };
    assert.equal(snapshot.queued.length, 128);
    assert.equal(overflowRan, false);
  } finally {
    release();
    await Promise.all(tasks);
  }
  assert.equal(started, 130);
  assert.equal(overflowRan, false, "rejected callback is never retained for later execution");
  assert.equal(await scheduler.run(132, "fs_read", meta, () => "recovered"), "recovered");
});

test("generic Git argv is exclusive across executable spellings; fixed inspections remain shared", async () => {
  const cwd = "D:\\Work\\Project";
  for (const command of ["git", "git.exe", " GIT.exe "]) {
    for (const args of [
      ["branch", "-D", "topic"], ["remote", "add", "origin", "https://example.invalid/repo"],
      ["diff", "--output=result.patch"], ["log", "--output=history.txt"],
      ["status"], ["-C", "nested", "status"], ["custom-alias"]
    ]) {
      assert.deepEqual(resourceClaims("command_run", { command, args, cwd }), [
        { key: "repo:d:\\work\\project", mode: "exclusive" }
      ], `${command} ${args.join(" ")}`);
    }
    assert.equal(classifyWorkload("command_run", { command, args: ["fetch"], cwd }), "wait");
  }
  for (const tool of ["git_status", "git_log", "git_diff", "project_snapshot"]) {
    assert.deepEqual(resourceClaims(tool, { path: cwd }), [{ key: "repo:d:\\work\\project", mode: "shared" }]);
  }

  const scheduler = new ExecutionScheduler({ read: 2, wait: 1, general: 2, cpu: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const tasks = [
    scheduler.run(1, "command_run", { command: "git.exe", args: ["remote", "add", "upstream", "unused"], cwd }, async () => {
      events.push("git-start"); await gate; events.push("git-end");
    }),
    scheduler.run(2, "git_status", { path: cwd }, () => { events.push("same-repo-read"); }),
    scheduler.run(3, "git_status", { path: "D:\\Git\\other" }, () => { events.push("other-repo-read"); })
  ];
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["git-start", "other-repo-read"]);
  } finally {
    release();
    await Promise.all(tasks);
  }
  assert.deepEqual(events, ["git-start", "other-repo-read", "git-end", "same-repo-read"]);
});

test("generic commands preserve independent sibling and nested cwd progress", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-scheduler-commands-"));
  const root = path.join(temporary, "workspace"), nested = path.join(root, "nested"), other = path.join(temporary, "other");
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(other);
    // This is a repository boundary, not merely a broad access grant.
    await mkdir(path.join(root, ".git"));
    for (const roots of [[nested, other, root], [root, nested, other]]) {
      const guard = await PathGuard.create(roots, false);
      const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 4, cpu: 4 }, guard);
      for (const command of ["node", "python", "npm", "bun"]) {
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const accepted = new Promise<void>((resolve) => { started = resolve; });
        const events: string[] = [];
        const first = scheduler.run(1, "command_run", { command, args: ["test"], cwd: nested }, async () => {
          events.push("command"); started(); await gate;
          throw new Error("fixture command failure");
        });
        const failed = assert.rejects(first, /fixture command failure/);
        await accepted;
        const following = [
          scheduler.run(2, "fs_write", { path: path.join(root, "sibling.txt") }, () => { events.push("file"); }),
          scheduler.run(3, "command_run", { command: "node", cwd: root }, () => { events.push("next-command"); })
        ];
        try {
          await scheduler.run(4, "command_run", { command: "node", cwd: other }, () => { events.push("independent"); });
          await Promise.all(following);
          assert.deepEqual([...events].sort(), ["command", "file", "independent", "next-command"], `${command}; first root ${roots[0]}`);
          assert.deepEqual(scheduler.snapshot().queued, []);
        } finally { release(); await Promise.all([failed, ...following]); }
        assert.deepEqual([...events].sort(), ["command", "file", "independent", "next-command"]);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("canceled queued writers release readers and never execute; accepted work keeps its lifetime", async () => {
  const scheduler = new ExecutionScheduler({ read: 2, wait: 1, general: 1, cpu: 1 });
  const meta = { path: "D:\\Work\\Project\\same.txt" };
  const activeSignal = new AbortController(), waitingSignal = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = scheduler.run(1, "fs_read", meta, () => gate, { signal: activeSignal.signal });
  let ran = false;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(getEventListeners(activeSignal.signal, "abort").length, 0);
    const waiting = scheduler.run(2, "fs_write", meta, () => { ran = true; }, { signal: waitingSignal.signal });
    const rejected = assert.rejects(waiting, /CANCELLED_BEFORE_ACCEPTANCE/);
    const reader = scheduler.run(3, "fs_read", meta, () => "reader progressed");
    waitingSignal.abort(new Error("sender-private-reason"));
    await rejected;
    assert.equal(await reader, "reader progressed");
    assert.equal(getEventListeners(waitingSignal.signal, "abort").length, 0);
    await assert.rejects(scheduler.run(4, "fs_write", meta, () => { ran = true; }, { signal: waitingSignal.signal }),
      /CANCELLED_BEFORE_ACCEPTANCE/);
    activeSignal.abort();
  } finally {
    release();
    await active;
  }
  assert.equal(ran, false);
  assert.equal(await scheduler.run(5, "fs_write", meta, () => "recovered"), "recovered");
});

test("queue deadlines expire without invoking callbacks, including delayed timer delivery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const scheduler = new ExecutionScheduler({ read: 1, wait: 1, general: 1, cpu: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = scheduler.run(1, "fs_read", {}, () => gate);
  const controller = new AbortController();
  let ran = false;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waiting = scheduler.run(2, "fs_read", {}, () => { ran = true; }, { queueTimeoutMs: 20, signal: controller.signal });
    const rejected = assert.rejects(waiting, /ADMISSION_DEADLINE_EXPIRED/);
    t.mock.timers.tick(20);
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(scheduler.snapshot().queued, []);
    for (const queueTimeoutMs of [0, -1, NaN, Infinity, 0.5, 30_001]) {
      await assert.rejects(scheduler.run(3, "fs_read", {}, () => { ran = true; }, { queueTimeoutMs }), /INVALID_ADMISSION_TIMEOUT/);
    }
  } finally {
    release();
    await active;
  }
  const delayed = scheduler.run(4, "fs_read", {}, () => { ran = true; });
  const rejected = assert.rejects(delayed, /ADMISSION_DEADLINE_EXPIRED/);
  t.mock.timers.setTime(Date.now() + 30_001); // Move the clock before the admission microtask; do not fire the timer.
  await rejected;
  assert.equal(ran, false);
  assert.equal(await scheduler.run(5, "fs_read", {}, () => "recovered"), "recovered");
});

test("runtime guard gives relative, absolute and junction aliases one file/cwd identity", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-scheduler-paths-"));
  const root = path.join(temporary, "root"), real = path.join(root, "real"), alias = path.join(root, "alias");
  try {
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "note.txt"), "fixture");
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    const guard = await PathGuard.create([root], false);
    const scheduler = new ExecutionScheduler({ read: 4, wait: 1, general: 4, cpu: 1 }, guard);
    for (const targets of [
      ["real/note.txt", path.join(real, "note.txt"), path.join(alias, "note.txt")],
      ["real/new.txt", path.join(real, "new.txt"), path.join(alias, "new.txt")]
    ]) {
      const events: string[] = [];
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const accepted = new Promise<void>((resolve) => { started = resolve; });
      const first = scheduler.run(1, "fs_write", { path: targets[0] }, async () => { events.push("first"); started(); await gate; });
      await accepted;
      const following = targets.slice(1).map((filename, i) => scheduler.run(i + 2, "fs_write", { path: filename }, () => { events.push(String(i)); }));
      try {
        await scheduler.run(4, "fs_write", { path: "independent.txt" }, () => { events.push("independent"); });
        assert.deepEqual(events, ["first", "independent"]);
        const queued = scheduler.snapshot().queued as Array<{ locks: unknown }>;
        assert.equal(queued.length, 2);
        assert.deepEqual(queued[0]!.locks, queued[1]!.locks);
      } finally { release(); await Promise.all([first, ...following]); }
      assert.deepEqual(events, ["first", "independent", "0", "1"]);
    }
    let deniedRan = false;
    for (const filename of [path.join(temporary, "outside.txt"), ".env"]) {
      await assert.rejects(scheduler.run(10, "fs_write", { path: filename }, () => { deniedRan = true; }), /outside configured roots|Sensitive file access/);
    }
    assert.equal(deniedRan, false);

    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const accepted = new Promise<void>((resolve) => { started = resolve; });
    const git = scheduler.run(11, "command_run", { command: "git", args: ["status"] }, async () => { started(); await gate; });
    await accepted;
    let readStarted = false;
    const reader = scheduler.run(12, "git_status", { path: root }, () => { readStarted = true; });
    try {
      await scheduler.run(13, "localhost_request", { url: "http://localhost", method: "GET" }, () => undefined);
      assert.equal(readStarted, false, "omitted command cwd locks the first approved root");
    } finally { release(); await Promise.all([git, reader]); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("canceled or expired path preparation stays bounded and never re-enters the queue", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lc-scheduler-prepare-"));
  const guard = await PathGuard.create([root], false);
  const scheduler = new ExecutionScheduler({ read: 2, wait: 1, general: 2, cpu: 1 }, guard);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(guard, "resolveForWrite", async () => { await gate; return path.join(root, "same.txt"); });
  let ran = false;
  try {
    const rejected: Promise<void>[] = [];
    for (let id = 0; id < 128; id++) {
      const controller = new AbortController();
      const job = scheduler.run(id, "fs_write", { path: "same.txt" }, () => { ran = true; }, { signal: controller.signal });
      rejected.push(assert.rejects(job, /CANCELLED_BEFORE_ACCEPTANCE/));
      controller.abort();
    }
    await Promise.all(rejected);
    assert.deepEqual(scheduler.snapshot().queued, []);
    assert.equal(scheduler.snapshot().preparing, 128);
    await assert.rejects(scheduler.run(129, "fs_write", { path: "same.txt" }, () => { ran = true; }), /SCHEDULER_QUEUE_FULL/);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scheduler.snapshot().preparing, 0);
    assert.equal(ran, false);
    assert.equal(await scheduler.run(130, "fs_write", { path: "same.txt" }, () => "recovered"), "recovered");
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    t.mock.method(guard, "resolveForWrite", async () => { await slow; return path.join(root, "same.txt"); });
    try {
      await assert.rejects(scheduler.run(131, "fs_write", { path: "same.txt" }, () => { ran = true; }, { queueTimeoutMs: 10 }), /ADMISSION_DEADLINE_EXPIRED/);
    } finally { finish(); }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ran, false);
    assert.equal(scheduler.snapshot().preparing, 0);
  } finally {
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("file and folder scopes conflict across tools while shared reads and independent roots overlap", async () => {
  const folder = path.resolve("scheduler-scope-fixture");
  const file = path.join(folder, "one.txt");
  const cases = [
    [["fs_write", { path: file }], ["fs_list", { path: folder }], true],
    [["fs_search", { path: folder }], ["fs_write", { path: file }], true],
    [["command_run", { command: "git", cwd: folder }], ["fs_read", { path: file }], true],
    [["fs_write", { path: file }], ["git_status", { path: folder }], true],
    [["fs_read", { path: file }], ["command_run", { command: "git", cwd: folder }], true],
    [["fs_search", { path: folder }], ["fs_read", { path: file }], false]
  ] as const;
  for (const [[firstTool, firstMeta], [secondTool, secondMeta], blocked] of cases) {
    const scheduler = new ExecutionScheduler({ read: 4, general: 4, wait: 1, cpu: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const first = scheduler.run(1, firstTool, firstMeta, async () => { events.push("first"); await gate; events.push("released"); });
    const rest = [scheduler.run(2, secondTool, secondMeta, () => { events.push("second"); })];
    if (firstTool === "fs_read") {
      rest.push(scheduler.run(3, "fs_read", { path: path.join(folder, "two.txt") }, () => { events.push("later-leaf"); }));
    }
    try {
      await scheduler.run(4, "fs_write", { path: path.join(folder + "-other", "file.txt") }, () => { events.push("independent"); });
      assert.equal(events.includes("second"), !blocked, `${firstTool} -> ${secondTool}`);
      assert.equal(events.includes("later-leaf"), false, "queued ancestor writer cannot be overtaken by another leaf reader");
    } finally { release(); await Promise.all([first, ...rest]); }
    if (blocked) assert.ok(events.indexOf("released") < events.indexOf("second"));
    if (firstTool === "fs_read") assert.ok(events.indexOf("second") < events.indexOf("later-leaf"));
  }
});
