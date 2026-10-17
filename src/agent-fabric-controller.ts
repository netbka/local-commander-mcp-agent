import { AgentWorkerMailbox } from "./agent-fabric-mailbox.js";
import { createFabricClock } from "./agent-fabric-timeline.js";
import type { FabricPayloadRef, WorkerAttribution } from "./agent-fabric-worker.js";
import type { RuntimeDispatchAdapter, RuntimeProvider } from "./controller-runtime-router.js";
import type { ControllerWorkers } from "./task-controller-supervisor.js";

type Worker = RuntimeDispatchAdapter & Pick<ControllerWorkers, "status">;
type Dispatch = Parameters<Worker["launch"]>[0];

/** Opt-in wrapper for TaskControllerSupervisor.runtimes. It preserves the existing
 * scheduler/launcher and adds durable coordination before effects. No timers or tools. */
export function coordinateFabricWorker(options: {
  mailbox: AgentWorkerMailbox; runtime: RuntimeProvider; worker: Worker;
  assignment(action: Dispatch): { workerId: string; payloadRef: FabricPayloadRef };
  // Only trusted adapter receipts, never model-authored messages or requested model labels.
  result?: (runId: string) => Promise<{ payloadRef: FabricPayloadRef; attribution?: Partial<WorkerAttribution> } | null>;
}): Worker {
  const { mailbox, worker, runtime } = options;
  const clock = createFabricClock();
  const find = async (runId: string) => (await mailbox.snapshot()).assignments.find(a => a.runId === runId && a.selectedRuntime === runtime);
  return {
    available: action => worker.available(action),
    async launch(action) {
      const assignment = await mailbox.assign({ ...options.assignment(action), runId: action.id, taskId: action.taskId,
        role: action.type === "dispatch_verifier" ? "verifier" : "implementer", selectedRuntime: runtime });
      if (assignment.phase === "exited" || assignment.phase === "running") return "started";
      if (!assignment.timeline.queued) await mailbox.timing(assignment.assignmentId, "queued",
        { stamp: clock(), source: "controller", evidenceRef: assignment.assignmentId });
      if (!await mailbox.claimLaunch(assignment.assignmentId)) throw Error("FABRIC_LAUNCH_OUTCOME_UNKNOWN");
      try {
        const outcome = await worker.launch(action);
        if (outcome !== "started" && outcome !== "not_started" && outcome !== "conflict") throw Error("FABRIC_LAUNCH_OUTCOME_UNKNOWN");
        await mailbox.phase(assignment.assignmentId, outcome === "started" ? "running" : "not_started");
        // "started" is durable acceptance, not proof of an OS/model start timestamp.
        return outcome;
      } catch (error) {
        await mailbox.phase(assignment.assignmentId, "unknown").catch(() => {});
        throw error;
      }
    },
    async status(runId) {
      const assignment = await find(runId);
      if (!assignment) return "unknown";
      if (assignment.phase === "assigned" || assignment.phase === "not_started") return "not_started";
      if (assignment.phase !== "exited") {
        const observed = await worker.status(runId).catch(() => "unknown" as const);
        if (observed === "exited") await mailbox.phase(assignment.assignmentId, "exited");
        else if (observed === "not_started" && assignment.phase === "launching") {
          // The original asynchronous launch may still accept. Only its own outcome
          // can release this intent; an early status read cannot authorize another launch.
          return "unknown";
        } else if (observed === "running" && assignment.phase !== "unknown") {
          await mailbox.phase(assignment.assignmentId, "running"); return "running";
        } else {
          await mailbox.phase(assignment.assignmentId, "unknown"); return "unknown";
        }
      }
      // Result forwarding is observational; a failed mailbox/attribution observer cannot
      // change a confirmed exit into running or replay an already accepted model request.
      if (options.result) {
        try {
          const result = await options.result(runId);
          if (result) {
            await mailbox.adapterResult(assignment.assignmentId, result.payloadRef);
            if (result.attribution) await mailbox.confirmAttribution(assignment.assignmentId, result.attribution);
          }
        } catch { /* Durable exit remains available; explicit reconciliation can retry result delivery. */ }
      }
      return "exited";
    }
  };
}
