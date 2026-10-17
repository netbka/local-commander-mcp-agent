import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";
import { FileControllerStore, MemoryControllerStore, type ControllerStore } from "../src/task-controller-store.js";
import { TaskControllerSupervisor, type ControllerRuntimeWorkers } from "../src/task-controller-supervisor.js";
import { createControllerState, parseControllerSnapshot, type ControllerSnapshot } from "../src/task-controller.js";

const notifier = { async send() {} };
type Adapter = NonNullable<ControllerRuntimeWorkers["runtimes"]["chatgpt"]>;
function adapter(launch: Adapter["launch"], status: Adapter["status"] = async () => "not_started"): Adapter {
  return { available: async () => true, launch, status };
}

test("runtime dispatch survives disk reopen, keeps repair provider and allows an independent verifier", async () => {
  const parent = path.resolve(os.tmpdir()), directory = await mkdtemp(path.join(parent, "lc-runtime-controller-"));
  try {
    const file = path.join(directory, "controller.json"), guard = await PathGuard.create([directory], false);
    const store = () => new FileControllerStore(guard, file);
    const receipts = new Map<string, "running" | "exited">(), calls: string[] = [];
    const workers: ControllerRuntimeWorkers = { runtimes: {} };
    for (const runtime of ["chatgpt", "claude"] as const) {
      workers.runtimes[runtime] = adapter(async action => {
        const durable = parseControllerSnapshot(JSON.parse(await readFile(file, "utf8")));
        assert.equal(durable.tasks[0]!.run?.runtime, runtime, "provider must be durable before effect");
        calls.push(runtime + ":" + action.id);
        if (runtime === "chatgpt" && action.type === "dispatch_implementer") return "not_started";
        receipts.set(runtime + ":" + action.id, "running");
        return "started";
      }, async id => receipts.get(runtime + ":" + id) ?? "not_started");
    }
    let controller = new TaskControllerSupervisor("owner", store(), workers, notifier);
    await controller.initialize([{ id: "task", assignee: "worker-one" }]);
    await controller.step();
    assert.deepEqual(calls, ["chatgpt:task.1", "claude:task.1"]);
    assert.equal((await controller.snapshot()).tasks[0]!.implementerRuntime, "claude");
    controller = new TaskControllerSupervisor("owner", store(), workers, notifier);
    assert.equal((await controller.step())[0]?.type, "wait");
    assert.equal(calls.length, 2);
    receipts.set("claude:task.1", "exited");
    await controller.step({ id: "candidate", taskId: "task", type: "candidate_ready", runId: "task.1" });
    assert.equal(calls.at(-1), "chatgpt:task.2");
    receipts.set("chatgpt:task.2", "exited");
    workers.runtimes.claude!.available = async () => false;
    assert.deepEqual(await controller.step({ id: "verdict", taskId: "task", type: "verifier_result", runId: "task.2", result: "CHANGES_REQUIRED" }),
      [{ type: "wait", taskId: "task", reason: "runtime_pinned" }]);
    controller = new TaskControllerSupervisor("owner", store(), workers, notifier);
    await controller.step();
    assert.equal(calls.length, 3, "unavailable repair provider cannot switch after restart");
    workers.runtimes.claude!.available = async () => true;
    await controller.step();
    assert.equal(calls.at(-1), "claude:task.3");
    assert.equal(calls.length, 4);
    assert.equal((await controller.snapshot()).tasks[0]!.implementerRuntime, "claude");
    const reassignment = { id: "reassign", taskId: "task", type: "implementer_reassigned", assignee: "worker-two" };
    await controller.step(reassignment);
    assert.equal(calls.length, 4, "reassignment cannot duplicate a live attempt");
    await controller.step({ id: "exit", taskId: "task", type: "worker_exited", runId: "task.3", reason: "finished" });
    workers.runtimes.chatgpt!.launch = async action => { calls.push("chatgpt:" + action.id); receipts.set("chatgpt:" + action.id, "running"); return "started"; };
    await controller.step({ id: "retry", taskId: "task", type: "retry_due" });
    assert.equal(calls.at(-1), "chatgpt:task.4");
    await controller.step(reassignment);
    assert.equal((await controller.snapshot()).tasks[0]!.implementerRuntime, "chatgpt", "replayed reassignment cannot clear the new provider pin");
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost post-launch save recovers only from the chosen runtime receipt", async () => {
  for (const receipt of ["running", "exited", "unknown", "missing-adapter", "not_started"] as const) {
    const backing = new MemoryControllerStore();
    let fail = true, attempts = 0, fallback = 0;
    const store: ControllerStore = { exclusive: fn => backing.exclusive((state, save) => fn(state, async next => {
      if (fail && next.tasks[0]!.run?.phase === "running") throw Error("disk failure after launch");
      await save(next);
    })) };
    const workers: ControllerRuntimeWorkers = { runtimes: {
      chatgpt: adapter(async () => { attempts++; return "started"; }),
      claude: adapter(async () => { fallback++; return "started"; })
    } };
    let controller = new TaskControllerSupervisor("owner", store, workers, notifier);
    await controller.initialize([{ id: "task" }]);
    await assert.rejects(controller.step(), /disk failure/);
    assert.equal((await controller.snapshot()).tasks[0]!.run?.phase, "pending");
    assert.equal((await controller.snapshot()).tasks[0]!.run?.runtime, "chatgpt");
    fail = false;
    if (receipt === "missing-adapter") delete workers.runtimes.chatgpt;
    else {
      workers.runtimes.chatgpt!.status = async () => receipt;
      workers.runtimes.chatgpt!.available = async () => false;
    }
    controller = new TaskControllerSupervisor("owner", store, workers, notifier);
    await controller.step();
    const task = (await controller.snapshot()).tasks[0]!;
    assert.equal(attempts, 1);
    assert.equal(fallback, receipt === "not_started" ? 1 : 0);
    assert.equal(task.run?.runtime, receipt === "not_started" ? "claude" : "chatgpt");
    assert.equal(task.run?.phase, receipt === "not_started" ? "running" : receipt === "missing-adapter" ? "unknown" : receipt);
  }
});

test("no available runtime, conflict and failed choice save do not switch or spend extra attempts", async () => {
  for (const condition of ["unavailable", "conflict", "save-failure", "ambiguous-launch"] as const) {
    const backing = new MemoryControllerStore();
    let launches = 0, fallback = 0;
    const store: ControllerStore = { exclusive: fn => backing.exclusive((state, save) => fn(state, async next => {
      if (condition === "save-failure" && next.tasks[0]!.run?.runtime) throw Error("disk failed");
      await save(next);
    })) };
    const workers: ControllerRuntimeWorkers = { runtimes: {
      chatgpt: adapter(async () => {
        launches++;
        if (condition === "ambiguous-launch") throw Error("unknown outcome");
        return "conflict";
      }),
      claude: adapter(async () => { fallback++; return "started"; })
    } };
    if (condition === "unavailable") {
      workers.runtimes.chatgpt!.available = async () => false;
      workers.runtimes.claude!.available = async () => false;
    }
    const controller = new TaskControllerSupervisor("owner", store, workers, notifier);
    await controller.initialize([{ id: "task" }]);
    if (condition === "save-failure") await assert.rejects(controller.step(), /disk failed/);
    else {
      const actions = await controller.step();
      assert.deepEqual(actions, [{ type: "wait", taskId: "task", reason: condition === "unavailable" ? "no_available_runtime" : condition === "conflict" ? "resource_conflict" : "unknown_worker" }]);
      await controller.step();
    }
    assert.equal((await controller.snapshot()).tasks[0]!.attempts, 1);
    assert.equal(launches, condition === "conflict" ? 2 : condition === "ambiguous-launch" ? 1 : 0);
    assert.equal(fallback, 0);
  }
});

test("controller mode and snapshot schema fail closed before an incompatible dispatch", async () => {
  const store = new MemoryControllerStore();
  const routed = new TaskControllerSupervisor("owner", store, { runtimes: {} }, notifier);
  await routed.initialize([{ id: "task", preferredRuntime: "cursor" }]);
  assert.equal((await routed.snapshot()).tasks[0]!.preferredRuntime, "cursor");
  const direct = new TaskControllerSupervisor("owner", store, {
    async status() { throw Error("must not probe"); }, async launch() { throw Error("must not dispatch"); }
  }, notifier);
  await assert.rejects(direct.step(), /CONTROLLER_WORKER_MODE_MISMATCH/);
  const state: ControllerSnapshot = createControllerState("owner", [{ id: "task" }]);
  assert.throws(() => parseControllerSnapshot({ ...state, version: 2 }), /CONTROLLER_STATE_INVALID/);
  assert.throws(() => parseControllerSnapshot({ ...state, workerMode: "other" }), /CONTROLLER_STATE_INVALID/);
  assert.throws(() => createControllerState("owner", [{ id: "task", preferredRuntime: "other" as never }]), /Invalid/);
});
