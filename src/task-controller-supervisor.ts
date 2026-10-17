import {
  applyControllerEvent, createControllerState, planController,
  type ControllerAction, type ControllerNotice, type ControllerSnapshot, type TaskDefinition
} from "./task-controller.js";
import type { ControllerStore } from "./task-controller-store.js";
import { routeControllerDispatch, type RuntimeDispatchAdapter, type RuntimeProvider } from "./controller-runtime-router.js";

type Dispatch = Extract<ControllerAction, { resources: string[] }>;
export interface ControllerWorkers {
  // "not_started" is authoritative absence, not a missing/lost process registry.
  // A lost registry must return "unknown"; running/exited identities survive restart.
  status(runId: string): Promise<"not_started" | "running" | "exited" | "unknown">;
  // Idempotent by action.id. Atomically admit all claims through the EXISTING
  // scheduler or return conflict without starting anything. No shell/policy data.
  launch(action: Dispatch): Promise<"started" | "conflict">;
}
export interface ControllerNotifier {
  // May be redelivered after a crash between send and save. Deduplicate by id.
  send(action: Omit<ControllerNotice, "delivered">): Promise<void>;
}
export type ControllerRuntimeWorkers = {
  runtimes: Partial<Record<RuntimeProvider, RuntimeDispatchAdapter & Pick<ControllerWorkers, "status">>>;
};

export class TaskControllerSupervisor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly controllerId: string,
    private readonly store: ControllerStore,
    private readonly workers: ControllerWorkers | ControllerRuntimeWorkers,
    private readonly notifier: ControllerNotifier
  ) {}
  private get workerMode(): ControllerSnapshot["workerMode"] {
    return "runtimes" in this.workers ? "runtime" : "direct";
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  initialize(tasks: TaskDefinition[]): Promise<void> {
    return this.serial(() => this.store.exclusive(async (state, save) => {
      if (state) throw Error("CONTROLLER_STORE_EXISTS");
      await save(createControllerState(this.controllerId, tasks, this.workerMode));
    }));
  }
  private owned(state: ControllerSnapshot | undefined): ControllerSnapshot {
    if (!state) throw Error("CONTROLLER_STORE_MISSING");
    if (state.controllerId !== this.controllerId) throw Error("CONTROLLER_OWNER_MISMATCH");
    if (state.workerMode !== this.workerMode) throw Error("CONTROLLER_WORKER_MODE_MISMATCH");
    return state;
  }
  snapshot(): Promise<ControllerSnapshot> {
    return this.serial(() => this.store.exclusive(async state => this.owned(state)));
  }
  step(event?: unknown): Promise<ControllerAction[]> {
    return this.serial(() => this.store.exclusive(async (loaded, save) => {
      const state = this.owned(loaded);
      if (event !== undefined) applyControllerEvent(state, event);
      for (const task of state.tasks) {
        if (task.status === "DONE" || !task.run) continue;
        const run = task.run;
        if (run.phase !== "exited") {
          const workers = "runtimes" in this.workers
            ? run.runtime ? this.workers.runtimes[run.runtime] : undefined
            : this.workers;
          // A runtime run without a choice has never crossed persist-before-launch.
          // A missing adapter/receipt for a recorded choice is never absence proof.
          const status = workers ? await workers.status(run.id).catch(() => "unknown" as const)
            : run.runtime ? "unknown" : "not_started";
          if (status === "running" || status === "exited") run.phase = status;
          else if (status !== "not_started" || run.phase !== "pending") run.phase = "unknown";
          else run.runtime = null; // Authoritative no-start permits fresh selection.
        }
        if (run.runtime && run.phase !== "pending" && run.role === "implementer" && run.assignee === task.assignee)
          task.implementerRuntime = run.runtime;
      }
      const planned = planController(state);
      await save(state); // Event, gate changes and launch intent are durable BEFORE effects.
      const emitted: ControllerAction[] = [];
      for (const action of planned) {
        if (action.type !== "dispatch_implementer" && action.type !== "dispatch_verifier") {
          emitted.push(action); continue;
        }
        const task = state.tasks.find(t => t.id === action.taskId)!;
        let outcome: "started" | "conflict" | "unknown";
        let reason = "resource_conflict";
        try {
          if ("runtimes" in this.workers) {
            const result = await routeControllerDispatch({
              action, preferred: task.preferredRuntime,
              pinned: (task.run!.runtime ?? (task.run!.role === "implementer" ? task.implementerRuntime : null)) ?? undefined,
              adapters: this.workers.runtimes,
              persistChoice: async runtime => { task.run!.runtime = runtime; await save(state); }
            });
            outcome = result.state === "started" ? "started" : result.reason === "unknown_outcome" ? "unknown" : "conflict";
            if (result.state === "blocked") reason = result.reason;
          } else outcome = await this.workers.launch(action);
        }
        catch { outcome = "unknown"; }
        if (outcome === "started") {
          task.run!.phase = "running";
          if (task.run!.role === "implementer") task.implementerRuntime = task.run!.runtime;
          emitted.push(action);
        } else {
          if (outcome === "conflict") task.status = task.run!.role === "verifier" ? "VERIFYING" : "READY";
          else task.run!.phase = "unknown";
          emitted.push({ type: "wait", taskId: task.id, reason: outcome === "conflict" ? reason : "unknown_worker" });
        }
        await save(state);
      }
      for (const notice of state.notices.filter(n => !n.delivered)) {
        const { delivered: _, ...action } = notice;
        try { await this.notifier.send(action); }
        catch { throw Error("CONTROLLER_NOTIFICATION_PENDING"); }
        notice.delivered = true;
        await save(state);
        emitted.push(action);
      }
      return emitted;
    }));
  }
}
