import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";
import {
  applyControllerEvent, createControllerState, parseControllerSnapshot, planController,
  type ControllerAction, type ControllerSnapshot, type TaskDefinition
} from "../src/task-controller.js";
import { FileControllerStore, MemoryControllerStore, type ControllerStore } from "../src/task-controller-store.js";
import { TaskControllerSupervisor, type ControllerNotifier, type ControllerWorkers } from "../src/task-controller-supervisor.js";

type Dispatch = Extract<ControllerAction, { resources: string[] }>;
class FakeWorkers implements ControllerWorkers {
  runs = new Map<string, "running" | "exited" | "unknown">();
  launches: Dispatch[] = [];
  held = new Set<string>();
  async status(id: string) { return this.runs.get(id) ?? "not_started" as const; }
  async launch(action: Dispatch): Promise<"started" | "conflict"> {
    if (this.runs.has(action.id)) return "started"; // Durable idempotency key.
    if (action.resources.some(key => this.held.has(key))) return "conflict";
    action.resources.forEach(key => this.held.add(key));
    this.launches.push(structuredClone(action));
    this.runs.set(action.id, "running");
    return "started";
  }
  exit(id: string) {
    this.runs.set(id, "exited");
    this.launches.find(a => a.id === id)?.resources.forEach(key => this.held.delete(key));
  }
}
class FakeNotifier implements ControllerNotifier {
  seen = new Set<string>();
  notices: ControllerAction[] = [];
  failAfterDelivery = false;
  async send(action: Parameters<ControllerNotifier["send"]>[0]) {
    if (!this.seen.has(action.id)) { this.seen.add(action.id); this.notices.push(action); }
    if (this.failAfterDelivery) { this.failAfterDelivery = false; throw Error("synthetic uncertain delivery"); }
  }
}
async function harness(definitions: TaskDefinition[] = [{ id: "task" }], store: ControllerStore = new MemoryControllerStore()) {
  const workers = new FakeWorkers(), notifier = new FakeNotifier();
  let supervisor = new TaskControllerSupervisor("owner", store, workers, notifier);
  await supervisor.initialize(definitions);
  let serial = 0;
  return {
    store, workers, notifier,
    get supervisor() { return supervisor; },
    restart() { supervisor = new TaskControllerSupervisor("owner", store, workers, notifier); },
    async state() { return supervisor.snapshot(); },
    async task(id = "task") { return (await supervisor.snapshot()).tasks.find(t => t.id === id)!; },
    event(type: string, fields: Record<string, unknown> = {}, taskId = "task") {
      return { id: "event-" + ++serial, taskId, type, ...fields };
    },
    async candidate(taskId = "task") {
      const task = (await supervisor.snapshot()).tasks.find(t => t.id === taskId)!;
      workers.exit(task.run!.id);
      return supervisor.step(this.event("candidate_ready", { runId: task.run!.id }, taskId));
    },
    async verdict(result: "ACCEPT" | "CHANGES_REQUIRED", taskId = "task") {
      const task = (await supervisor.snapshot()).tasks.find(t => t.id === taskId)!;
      workers.exit(task.run!.id);
      return supervisor.step(this.event("verifier_result", { runId: task.run!.id, result }, taskId));
    }
  };
}
async function withDisk(fn: (store: FileControllerStore, file: string, guard: PathGuard) => Promise<void>) {
  const parent = os.tmpdir();
  const directory = await mkdtemp(path.join(parent, "lc-controller-test-"));
  assert.equal(path.dirname(directory), path.resolve(parent));
  try {
    const file = path.join(directory, "controller.json");
    const guard = await PathGuard.create([directory], false);
    await fn(new FileControllerStore(guard, file), file, guard);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    await rm(directory, { recursive: true, force: true });
  }
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  { name: "candidate dispatches a required verifier, not completion", async run() {
    const h = await harness();
    assert.equal((await h.supervisor.step())[0]?.type, "dispatch_implementer");
    await h.supervisor.step(h.event("worker_started", { runId: (await h.task()).run!.id }));
    assert.equal(h.workers.launches.length, 1);
    assert.equal((await h.candidate())[0]?.type, "dispatch_verifier");
    assert.equal((await h.task()).status, "VERIFYING");
    assert.equal((await h.task()).accepted, false);
  }},
  { name: "ACCEPT waits for completion conditions", async run() {
    const h = await harness([{ id: "task", conditions: ["check"] }]);
    await h.supervisor.step(); await h.candidate(); await h.verdict("ACCEPT");
    assert.equal((await h.task()).status, "BLOCKED_DEPENDENCY");
    await h.supervisor.step(h.event("dependency_resolved", { kind: "condition", key: "check" }));
    assert.equal((await h.task()).status, "DONE");
    assert.equal(h.notifier.notices.filter(a => a.type === "complete").length, 1);
  }},
  { name: "CHANGES_REQUIRED repairs within a fixed dispatch budget", async run() {
    const h = await harness([{ id: "task", maxAttempts: 3 }]);
    await h.supervisor.step(); await h.candidate();
    const actions = await h.verdict("CHANGES_REQUIRED");
    assert.equal(actions[0]?.type, "dispatch_implementer");
    assert.equal((await h.task()).accepted, false);
    await h.candidate(); // Budget has only allowed implementer, verifier, repair.
    assert.equal((await h.task()).status, "NEEDS_USER");
    assert.equal(h.workers.launches.length, 3);
    await h.supervisor.step(h.event("retry_due"));
    assert.equal(h.workers.launches.length, 3);
    assert.equal(h.notifier.notices.filter(a => a.type === "notify_owner").length, 1);
  }},
  { name: "B2 owner action resolves by matching ID and rechecks dependencies", async run() {
    const h = await harness([{ id: "task", dependencies: ["dependency"] }]);
    await h.supervisor.step(h.event("owner_action_required", { actionId: "approval" }));
    assert.equal((await h.task()).status, "NEEDS_USER");
    await h.supervisor.step(h.event("retry_due"));
    await h.supervisor.step(h.event("owner_action_resolved", { actionId: "other" }));
    assert.equal((await h.task()).status, "NEEDS_USER");
    await h.supervisor.step(h.event("owner_action_resolved", { actionId: "approval" }));
    assert.equal((await h.task()).status, "BLOCKED_DEPENDENCY");
    await h.supervisor.step(h.event("dependency_resolved", { kind: "dependency", key: "dependency" }));
    assert.equal((await h.task()).status, "WORKING");
    assert.equal(h.workers.launches.length, 1);
    assert.equal((await h.task()).accepted, false);
  }},
  { name: "B4 external recovery resumes but cannot accept", async run() {
    const h = await harness(); await h.supervisor.step();
    const run = (await h.task()).run!.id; h.workers.exit(run);
    await h.supervisor.step(h.event("worker_exited", { runId: run, reason: "external_wait", externalId: "provider" }));
    assert.equal((await h.task()).status, "WAIT_EXTERNAL");
    await h.supervisor.step(h.event("retry_due"));
    await h.supervisor.step(h.event("external_recovered", { externalId: "other" }));
    assert.equal(h.workers.launches.length, 1);
    await h.supervisor.step(h.event("external_recovered", { externalId: "provider" }));
    assert.equal((await h.task()).status, "WORKING");
    assert.equal(h.workers.launches.length, 2);
    assert.equal((await h.task()).accepted, false);
  }},
  ...[["left", "right"], ["right", "left"]].map(order => ({
    name: "parent waits for both required children: " + order.join(","),
    async run() {
      const h = await harness([{ id: "task" }, { id: "left", parentId: "task", verifierRequired: false },
        { id: "right", parentId: "task", verifierRequired: false }]);
      await h.supervisor.step(); await h.candidate(); await h.verdict("ACCEPT");
      assert.equal((await h.task()).status, "BLOCKED_DEPENDENCY");
      await h.candidate(order[0]);
      assert.equal((await h.task()).status, "BLOCKED_DEPENDENCY");
      await h.candidate(order[1]);
      assert.equal((await h.task()).status, "DONE");
      assert.equal(h.notifier.notices.filter(a => a.type === "resume_parent").length, 2);
      assert.equal((await h.state()).controllerId, "owner");
    }
  })),
  { name: "conflicting workspace/resource admission waits and preserves its intent", async run() {
    const h = await harness([{ id: "task", resources: ["workspace", "git-common"] },
      { id: "second", resources: ["git-common"], verifierRequired: false }]);
    const actions = await h.supervisor.step();
    assert.ok(actions.some(a => a.type === "wait" && a.reason === "resource_conflict"));
    assert.equal(h.workers.launches.length, 1);
    assert.equal((await h.task("second")).status, "READY");
    const reserved = (await h.task("second")).run!.id;
    await h.candidate(); await h.verdict("ACCEPT");
    assert.equal(h.workers.launches.at(-1)?.id, reserved);
    assert.equal((await h.task("second")).attempts, 1);
  }},
  { name: "worker exit alone never completes", async run() {
    const h = await harness(); await h.supervisor.step();
    const run = (await h.task()).run!.id; h.workers.exit(run);
    await h.supervisor.step(h.event("worker_exited", { runId: run, reason: "finished" }));
    assert.equal((await h.task()).status, "READY");
    assert.equal((await h.task()).accepted, false);
    assert.equal(h.workers.launches.length, 1);
    assert.equal(h.notifier.notices.filter(a => a.type === "complete").length, 0);
  }},
  { name: "candidate and ACCEPT still wait for confirmed worker exit", async run() {
    const h = await harness(); await h.supervisor.step();
    await h.supervisor.step(h.event("candidate_ready", { runId: (await h.task()).run!.id }));
    assert.equal((await h.task()).status, "VERIFYING");
    assert.equal(h.workers.launches.length, 1);
    h.workers.exit((await h.task()).run!.id); await h.supervisor.step();
    await h.supervisor.step(h.event("verifier_result", { runId: (await h.task()).run!.id, result: "ACCEPT" }));
    assert.equal((await h.task()).status, "VERIFYING");
    h.workers.exit((await h.task()).run!.id); await h.supervisor.step();
    assert.equal((await h.task()).status, "DONE");
  }}
];
for (const scenario of cases) test(scenario.name, scenario.run);

for (const status of ["running", "unknown", "exited"] as const) {
  test("restart reconciles interrupted WORKING with worker status " + status, async () => withDisk(async store => {
    const h = await harness(undefined, store); await h.supervisor.step();
    const run = (await h.task()).run!.id;
    h.workers.runs.set(run, status); h.restart();
    const actions = await h.supervisor.step();
    assert.notEqual((await h.task()).status, "DONE");
    assert.equal(h.workers.launches.length, 1);
    if (status === "exited") {
      assert.equal((await h.task()).status, "READY");
      await h.supervisor.step(h.event("retry_due"));
      assert.equal(h.workers.launches.length, 2);
    }
    if (status === "unknown") assert.ok(actions.some(a => a.type === "wait" && a.reason === "unknown_worker"));
    assert.equal((await h.state()).controllerId, "owner");
  }));
}
test("duplicate event is idempotent before and after file reload; DONE never redispatches", async () => withDisk(async (store, file, guard) => {
  const h = await harness(undefined, store); await h.supervisor.step();
  const event = h.event("worker_progress", { runId: (await h.task()).run!.id });
  await h.supervisor.step(event);
  const before = await h.state();
  await h.supervisor.step(event);
  assert.deepEqual(await h.state(), before);
  const reopened = new TaskControllerSupervisor("owner", new FileControllerStore(guard, file), h.workers, h.notifier);
  await reopened.step(event);
  assert.deepEqual(await reopened.snapshot(), before);
  await h.candidate(); await h.verdict("ACCEPT");
  const done = await h.state(), count = h.workers.launches.length;
  await reopened.step(event); await reopened.step();
  assert.deepEqual(await reopened.snapshot(), done);
  assert.equal(h.workers.launches.length, count);
}));
test("persisted intent survives a crash before launch and after launch before acknowledgement", async () => {
  for (const launched of [false, true]) await withDisk(async store => {
    const h = await harness(undefined, store);
    const state = await h.state();
    state.tasks[0]!.attempts = 1; state.tasks[0]!.status = "WORKING";
    state.tasks[0]!.run = { id: "task.1", phase: "pending", role: "implementer", verdict: null, assignee: null, runtime: null };
    await store.exclusive(async (_, save) => save(state));
    if (launched) await h.workers.launch({ id: "task.1", taskId: "task", type: "dispatch_implementer", resources: [], assignee: null });
    h.restart(); await h.supervisor.step();
    assert.equal(h.workers.launches.length, 1);
    assert.equal((await h.task()).run!.id, "task.1");
    assert.equal((await h.task()).attempts, 1);
  });
});
test("exit before candidate or verifier result preserves the result identity across restart", async () => withDisk(async store => {
  const h = await harness(undefined, store); await h.supervisor.step();
  const implementer = (await h.task()).run!.id; h.workers.exit(implementer);
  await h.supervisor.step(h.event("worker_exited", { runId: implementer, reason: "finished" }));
  h.restart();
  await h.supervisor.step(h.event("candidate_ready", { runId: implementer }));
  assert.equal((await h.task()).status, "VERIFYING");
  assert.equal(h.workers.launches.length, 2);
  const verifier = (await h.task()).run!.id; h.workers.exit(verifier);
  await h.supervisor.step(h.event("worker_exited", { runId: verifier, reason: "finished" }));
  h.restart();
  await h.supervisor.step(h.event("verifier_result", { runId: verifier, result: "ACCEPT" }));
  assert.equal((await h.task()).status, "DONE");
  assert.equal(h.workers.launches.length, 2);
}));
test("notification redelivery is keyed and completed tasks do not relaunch", async () => {
  const h = await harness([{ id: "task", verifierRequired: false }]); await h.supervisor.step();
  h.notifier.failAfterDelivery = true;
  await assert.rejects(h.candidate(), /CONTROLLER_NOTIFICATION_PENDING/);
  assert.equal((await h.task()).status, "DONE");
  h.restart(); await h.supervisor.step();
  assert.equal(h.notifier.notices.length, 1);
  assert.equal(h.workers.launches.length, 1);
  assert.equal((await h.state()).notices[0]!.delivered, true);
});
test("store failure before dispatch produces no worker effect", async () => {
  const backing = new MemoryControllerStore();
  let fail = false;
  const store: ControllerStore = { exclusive: fn => backing.exclusive((state, save) =>
    fn(state, async next => { if (fail) throw Error("synthetic save failure"); await save(next); })) };
  const h = await harness(undefined, store); fail = true;
  await assert.rejects(h.supervisor.step(), /synthetic save failure/);
  assert.equal(h.workers.launches.length, 0);
  fail = false; assert.equal((await h.task()).attempts, 0);
});
test("launch acknowledgement lost after a worker starts is reconciled without duplication", async () => {
  const h = await harness();
  const launch = h.workers.launch.bind(h.workers);
  h.workers.launch = async action => { await launch(action); throw Error("synthetic lost reply"); };
  await h.supervisor.step();
  assert.equal((await h.task()).run!.phase, "unknown");
  h.restart(); await h.supervisor.step();
  assert.equal((await h.task()).run!.phase, "running");
  assert.equal(h.workers.launches.length, 1);
});
test("owner identity, internal dependency evidence and stale verifier results cannot be bypassed", async () => {
  const h = await harness([{ id: "dependency", verifierRequired: false }, { id: "task", dependencies: ["dependency"] }]);
  const other = new TaskControllerSupervisor("other-owner", h.store, h.workers, h.notifier);
  await assert.rejects(other.step(), /CONTROLLER_OWNER_MISMATCH/);
  await h.supervisor.step(h.event("dependency_resolved", { kind: "dependency", key: "dependency" }));
  assert.equal((await h.task()).status, "BLOCKED_DEPENDENCY");
  await h.candidate("dependency"); await h.candidate();
  const oldRun = (await h.task()).run!.id;
  await h.verdict("CHANGES_REQUIRED");
  await h.supervisor.step(h.event("verifier_result", { runId: oldRun, result: "ACCEPT" }));
  assert.equal((await h.task()).accepted, false);
  assert.equal((await h.task()).status, "WORKING");
});
test("strict metadata boundary rejects content, reused event IDs and impossible graphs/states", async () => {
  const h = await harness();
  const event = h.event("owner_action_required", { actionId: "approval" });
  await assert.rejects(h.supervisor.step({ ...event, prompt: "synthetic private content" }), /CONTROLLER_EVENT_INVALID/);
  await h.supervisor.step(event);
  await assert.rejects(h.supervisor.step({ ...event, actionId: "different" }), /CONTROLLER_EVENT_ID_CONFLICT/);
  const state = await h.state();
  const missing = structuredClone(state) as any; delete missing.tasks[0].dependencies;
  assert.throws(() => parseControllerSnapshot(missing), /CONTROLLER_STATE_INVALID/);
  assert.throws(() => parseControllerSnapshot({ ...state, outputBody: "synthetic" }), /CONTROLLER_STATE_INVALID/);
  assert.throws(() => createControllerState("owner", [{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }]), /CONTROLLER_STATE_INVALID/);
  assert.throws(() => createControllerState("owner", [{ id: "a", parentId: "a" }]), /CONTROLLER_STATE_INVALID/);
  const fakeDone = structuredClone(state); fakeDone.tasks[0]!.status = "DONE";
  assert.throws(() => parseControllerSnapshot(fakeDone), /CONTROLLER_STATE_INVALID/);
  assert.equal(JSON.stringify(state).includes("synthetic private content"), false);
});
test("file persistence is atomic, reloadable and leaves the last snapshot on failed replacement", async () => withDisk(async (store, file, guard) => {
  const h = await harness(undefined, store);
  const original = await readFile(file, "utf8");
  const resolve = guard.resolveForWrite.bind(guard);
  let targetChecks = 0;
  guard.resolveForWrite = async (value: string) => {
    if (value === file && ++targetChecks === 3) throw Error("synthetic before-rename failure");
    return resolve(value);
  };
  await assert.rejects(h.supervisor.step(), /synthetic before-rename failure/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await readdir(path.dirname(file)), ["controller.json"]);
  guard.resolveForWrite = resolve;
  const observations: ControllerSnapshot[] = [];
  const writer = h.supervisor.step();
  for (let i = 0; i < 8; i++) observations.push(parseControllerSnapshot(JSON.parse(await readFile(file, "utf8"))));
  await writer;
  assert.ok(observations.every(s => s.tasks[0]!.attempts === 0 || s.tasks[0]!.attempts === 1));
  assert.equal((await h.task()).run!.phase, "running");
  assert.deepEqual(await readdir(path.dirname(file)), ["controller.json"]);
}));
for (const corrupted of ["", "{", '{"version":2}', '{"version":99,"tasks":[]}',
  // A version-1 store predates the required implementer assignment.
  '{"version":1,"controllerId":"owner","tasks":[{"id":"task","parentId":null,"dependencies":[],"conditions":[],"resources":[],"verifierRequired":true,"maxAttempts":6,"status":"READY","attempts":0,"run":null,"candidate":null,"accepted":false,"retryRequested":false,"resolvedDependencies":[],"satisfiedConditions":[],"ownerActions":[],"externalWaits":[]}],"events":[],"notices":[]}']) {
  test("malformed/truncated store fails closed: " + JSON.stringify(corrupted), async () => withDisk(async (store, file) => {
    const h = await harness(undefined, store); await writeFile(file, corrupted);
    await assert.rejects(h.supervisor.step(), /CONTROLLER_STORE_CORRUPT/);
    await assert.rejects(h.supervisor.initialize([{ id: "replacement" }]), /CONTROLLER_STORE_CORRUPT/);
    assert.equal(await readFile(file, "utf8"), corrupted);
    assert.equal(h.workers.launches.length, 0);
  }));
}
test("CHANGES_REQUIRED repair returns to the same implementer across restart", async () => withDisk(async store => {
  const h = await harness([{ id: "task", assignee: "implementer-a", maxAttempts: 4 }], store);
  const first = await h.supervisor.step();
  assert.equal(first[0]?.type, "dispatch_implementer");
  assert.equal((first[0] as Dispatch).assignee, "implementer-a");
  await h.candidate();
  // Verification must not inherit the implementer identity.
  assert.equal(h.workers.launches.at(-1)?.assignee, null);
  assert.equal((await h.task()).run!.assignee, null);
  h.restart();
  const repair = await h.verdict("CHANGES_REQUIRED");
  assert.equal(repair[0]?.type, "dispatch_implementer");
  assert.equal((repair[0] as Dispatch).assignee, "implementer-a");
  assert.equal((await h.task()).run!.assignee, "implementer-a");
  h.restart();
  assert.equal((await h.task()).assignee, "implementer-a");
}));
test("only an explicit reassignment moves repair, and replaying it is a no-op", async () => withDisk(async store => {
  const h = await harness([{ id: "task", assignee: "implementer-a", maxAttempts: 6 }], store);
  await h.supervisor.step();
  const live = (await h.task()).run!.id;
  const reassign = h.event("implementer_reassigned", { assignee: "implementer-b" });
  await h.supervisor.step(reassign);
  // A started attempt keeps the owner it was given; the change applies next dispatch.
  assert.equal((await h.task()).run!.assignee, "implementer-a");
  assert.equal((await h.task()).assignee, "implementer-b");
  await h.candidate();
  h.restart();
  const repair = await h.verdict("CHANGES_REQUIRED");
  assert.equal((repair[0] as Dispatch).assignee, "implementer-b");
  const before = await h.state();
  await h.supervisor.step(reassign);
  assert.deepEqual(await h.state(), before);
  assert.equal(h.workers.launches.filter(a => a.id === live).length, 1);
  await h.supervisor.step(h.event("implementer_reassigned", { assignee: null }));
  assert.equal((await h.task()).assignee, null);
}));
test("reassignment cannot disturb a completed task or forge a verifier owner", async () => {
  const h = await harness([{ id: "task", assignee: "implementer-a", verifierRequired: false }]);
  await h.supervisor.step(); await h.candidate();
  assert.equal((await h.task()).status, "DONE");
  await h.supervisor.step(h.event("implementer_reassigned", { assignee: "implementer-b" }));
  assert.equal((await h.task()).assignee, "implementer-a");
  assert.equal((await h.task()).status, "DONE");
  const forged = await h.state();
  forged.tasks[0]!.run = { id: "task.9", role: "verifier", phase: "pending", verdict: null, assignee: "implementer-a", runtime: null };
  assert.throws(() => parseControllerSnapshot(forged), /CONTROLLER_STATE_INVALID/);
  await assert.rejects(h.supervisor.step({ ...h.event("implementer_reassigned"), assignee: { name: "x" } }), /CONTROLLER_EVENT_INVALID/);
});
test("a long-lived controller outlives the receipt bound and keeps replay a no-op", () => {
  const state = createControllerState("owner", [{ id: "task", maxAttempts: 32 }]);
  const progress = (runId: string, serial: number) =>
    ({ id: "progress-" + serial, taskId: "task", type: "worker_progress", runId });
  let applied = 0;
  const pruned = { id: "", taskId: "task", type: "worker_progress", runId: "" };
  for (let attempt = 0; attempt < 32; attempt++) {
    planController(state);
    const run = state.tasks[0]!.run!.id;
    for (let i = 0; i < 200; i++) {
      applyControllerEvent(state, progress(run, ++applied));
      if (attempt === 0 && i === 0) Object.assign(pruned, progress(run, applied));
    }
    applyControllerEvent(state, { id: "exit-" + attempt, taskId: "task", type: "worker_exited", runId: run, reason: "finished" });
    applyControllerEvent(state, { id: "retry-" + attempt, taskId: "task", type: "retry_due" });
    applied += 2;
  }
  assert.ok(applied > 4096, "the run must cross the receipt bound");
  assert.ok(state.events.length < 4096);
  assert.equal(state.tasks[0]!.attempts, 32);
  parseControllerSnapshot(state);
  // Retry receipts stay because their replay would spend another attempt.
  assert.equal(state.events.filter(e => e.type === "retry_due").length, 32);
  assert.equal(state.events.some(e => e.id === pruned.id), false);
  const before = structuredClone(state.tasks[0]);
  applyControllerEvent(state, pruned);
  assert.deepEqual(state.tasks[0], before);
});
test("receipts that can still change a live task fail closed instead of being dropped", () => {
  const state = createControllerState("owner", [{ id: "task" }]);
  planController(state);
  const run = state.tasks[0]!.run!.id;
  for (let i = 0; i < 4096; i++)
    applyControllerEvent(state, { id: "live-" + i, taskId: "task", type: "worker_progress", runId: run });
  const frozen = structuredClone(state);
  assert.throws(() => applyControllerEvent(state, { id: "overflow", taskId: "task", type: "retry_due" }), /CONTROLLER_HISTORY_FULL/);
  assert.deepEqual(state, frozen);
  parseControllerSnapshot(state);
});
test("exclusive store access fails closed without stealing another controller's lock", async () => withDisk(async (store, file, guard) => {
  const h = await harness(undefined, store);
  await store.exclusive(async () => {
    const second = new TaskControllerSupervisor("owner", new FileControllerStore(guard, file), h.workers, h.notifier);
    await assert.rejects(second.step(), /CONTROLLER_STORE_BUSY/);
    assert.equal(h.workers.launches.length, 0);
  });
  await writeFile(file + ".lock", "synthetic interrupted store writer");
  await assert.rejects(h.supervisor.step(), /CONTROLLER_STORE_BUSY/);
  assert.equal(await readFile(file + ".lock", "utf8"), "synthetic interrupted store writer");
}));
