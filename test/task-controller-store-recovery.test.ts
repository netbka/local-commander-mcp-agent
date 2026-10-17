import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";
import { createControllerState } from "../src/task-controller.js";
import { FileControllerStore } from "../src/task-controller-store.js";

type LockRecord = { version: 1; pid: number; token: string; acquiredAt: number };

function record(pid: number, patch: Partial<LockRecord> = {}): LockRecord {
  return { version: 1, pid, token: randomUUID(), acquiredAt: Date.now() - 1000, ...patch };
}
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}
async function withDisk(fn: (store: FileControllerStore, file: string, guard: PathGuard) => Promise<void>) {
  const parent = os.tmpdir();
  const directory = await mkdtemp(path.join(parent, "lc-controller-recovery-"));
  assert.equal(path.dirname(directory), path.resolve(parent));
  try {
    const file = path.join(directory, "controller.json");
    const guard = await PathGuard.create([directory], false);
    await fn(new FileControllerStore(guard, file), file, guard);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function seed(store: FileControllerStore, file: string): Promise<string> {
  const state = createControllerState("owner", [{ id: "task" }]);
  await store.exclusive(async (_, save) => save(state));
  return readFile(file, "utf8");
}

test("dead lock owner is recovered without changing the snapshot", async () => withDisk(async (store, file) => {
  const before = await seed(store, file);
  const pid = await exitedPid();
  await writeFile(file + ".lock", JSON.stringify(record(pid)), { mode: 0o600 });

  let seen = false;
  await store.exclusive(async state => {
    seen = true;
    assert.equal(state?.controllerId, "owner");
  });

  assert.equal(seen, true);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(readFile(file + ".lock", "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}));

test("a live owner is never robbed even when the lock is old", async () => withDisk(async (store, file) => {
  const live = record(process.pid, { acquiredAt: Date.now() - 24 * 60 * 60_000 });
  await writeFile(file + ".lock", JSON.stringify(live), { mode: 0o600 });

  await assert.rejects(store.exclusive(async () => {}), /CONTROLLER_STORE_BUSY/);
  assert.deepEqual(JSON.parse(await readFile(file + ".lock", "utf8")), live);
}));

test("a different live process is never robbed", async () => withDisk(async (store, file) => {
  // The self-PID shortcut cannot prove this; use a real foreign live process.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const live = record(child.pid!);
  try {
    await writeFile(file + ".lock", JSON.stringify(live), { mode: 0o600 });
    await assert.rejects(store.exclusive(async () => {}), /CONTROLLER_STORE_BUSY/);
    assert.deepEqual(JSON.parse(await readFile(file + ".lock", "utf8")), live);
  } finally {
    child.kill();
    await once(child, "exit");
  }
}));

test("unknown or malformed ownership refuses instead of stealing", async () => withDisk(async (store, file) => {
  for (const body of [
    "not-json",
    JSON.stringify({ version: 1, pid: process.pid, token: "short", acquiredAt: Date.now() }),
    JSON.stringify(record(process.pid, { acquiredAt: Date.now() + 10 * 60_000 }))
  ]) {
    await writeFile(file + ".lock", body, { mode: 0o600 });
    await assert.rejects(store.exclusive(async () => {}), /CONTROLLER_STORE_BUSY/);
    assert.equal(await readFile(file + ".lock", "utf8"), body);
  }
}));

test("two simultaneous stale-lock recoveries admit only one callback", async () => withDisk(async (store, file, guard) => {
  const pid = await exitedPid();
  await writeFile(file + ".lock", JSON.stringify(record(pid)), { mode: 0o600 });
  const second = new FileControllerStore(guard, file);
  let entered = 0;
  const attempt = (candidate: FileControllerStore) => candidate.exclusive(async () => {
    entered += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    return "entered";
  });

  const results = await Promise.allSettled([attempt(store), attempt(second)]);
  assert.equal(entered, 1);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /CONTROLLER_STORE_BUSY/);
}));

test("an orphaned recovery gate is itself recoverable", async () => withDisk(async (store, file) => {
  const deadMain = await exitedPid();
  const deadGate = await exitedPid();
  await writeFile(file + ".lock", JSON.stringify(record(deadMain)), { mode: 0o600 });
  await writeFile(file + ".lock.recovery", JSON.stringify(record(deadGate)), { mode: 0o600 });

  let entered = false;
  await store.exclusive(async () => { entered = true; });
  assert.equal(entered, true);
  await assert.rejects(readFile(file + ".lock.recovery", "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}));

test("recovery never masks a corrupt snapshot", async () => withDisk(async (store, file) => {
  const corrupt = "{broken";
  await writeFile(file, corrupt);
  await writeFile(file + ".lock", JSON.stringify(record(await exitedPid())), { mode: 0o600 });

  await assert.rejects(store.exclusive(async () => {}), /CONTROLLER_STORE_CORRUPT/);
  assert.equal(await readFile(file, "utf8"), corrupt);
}));
