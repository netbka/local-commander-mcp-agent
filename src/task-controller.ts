import { z } from "zod";
import { LOCAL_RUNTIME_PROVIDERS } from "./controller-runtime-router.js";

// Only opaque coordination IDs and bounded metadata cross this boundary.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ids = z.array(id).max(128).refine(v => new Set(v).size === v.length);
const runtime = z.enum(LOCAL_RUNTIME_PROVIDERS);
export const TaskDefinitionSchema = z.strictObject({
  id, parentId: id.nullable().default(null),
  dependencies: ids.default([]), conditions: ids.default([]), resources: ids.default([]),
  verifierRequired: z.boolean().default(true), maxAttempts: z.number().int().min(1).max(32).default(6),
  // Opaque implementer identity. Repair returns here by default; only an
  // explicit reassignment event may change it.
  assignee: id.nullable().default(null), preferredRuntime: runtime.default("chatgpt")
});
export type TaskDefinition = z.input<typeof TaskDefinitionSchema>;
const RunSchema = z.strictObject({
  id: runId, role: z.enum(["implementer", "verifier"]),
  phase: z.enum(["pending", "running", "unknown", "exited"]),
  verdict: z.enum(["ACCEPT", "CHANGES_REQUIRED"]).nullable(),
  // Which implementer this attempt was dispatched to, so same-owner repair stays
  // provable across restart. A verifier never carries an implementer identity.
  assignee: id.nullable(), runtime: runtime.nullable()
});
const TaskSchema = z.strictObject({
  id, parentId: id.nullable(), dependencies: ids, conditions: ids, resources: ids,
  verifierRequired: z.boolean(), maxAttempts: z.number().int().min(1).max(32),
  status: z.enum(["WORKING", "READY", "BLOCKED_DEPENDENCY", "NEEDS_USER", "WAIT_EXTERNAL", "VERIFYING", "DONE"]),
  attempts: z.number().int().min(0).max(32), run: RunSchema.nullable(),
  candidate: runId.nullable(), accepted: z.boolean(), retryRequested: z.boolean(),
  resolvedDependencies: ids, satisfiedConditions: ids, ownerActions: ids, externalWaits: ids,
  assignee: id.nullable(), preferredRuntime: runtime, implementerRuntime: runtime.nullable()
});
export type ControllerTask = z.infer<typeof TaskSchema>;
const baseEvent = z.strictObject({ id, taskId: id });
export const ControllerEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({ type: z.literal("worker_started"), runId }),
  baseEvent.extend({ type: z.literal("worker_progress"), runId }),
  baseEvent.extend({ type: z.literal("worker_exited"), runId,
    reason: z.enum(["finished", "interrupted", "external_wait"]), externalId: id.optional() }),
  baseEvent.extend({ type: z.literal("candidate_ready"), runId }),
  baseEvent.extend({ type: z.literal("verifier_result"), runId, result: z.enum(["ACCEPT", "CHANGES_REQUIRED"]) }),
  baseEvent.extend({ type: z.literal("dependency_resolved"), kind: z.enum(["dependency", "condition"]), key: id }),
  baseEvent.extend({ type: z.literal("owner_action_required"), actionId: id }),
  baseEvent.extend({ type: z.literal("owner_action_resolved"), actionId: id }),
  baseEvent.extend({ type: z.literal("external_recovered"), externalId: id }),
  baseEvent.extend({ type: z.literal("retry_due") }),
  // Explicit owner/coordinator reassignment. The only way repair leaves its
  // current implementer, and it takes effect on the next dispatch.
  baseEvent.extend({ type: z.literal("implementer_reassigned"), assignee: id.nullable() })
]);
export type ControllerEvent = z.infer<typeof ControllerEventSchema>;
const NoticeSchema = z.strictObject({
  id: runId, taskId: id, type: z.enum(["notify_owner", "resume_parent", "complete"]),
  reason: z.enum(["B2", "attempt_limit", "child_done", "accepted"]), delivered: z.boolean()
});
export type ControllerNotice = z.infer<typeof NoticeSchema>;
export type ControllerAction =
  | Omit<ControllerNotice, "delivered">
  | { type: "dispatch_implementer" | "dispatch_verifier"; id: string; taskId: string; resources: string[]; assignee: string | null }
  | { type: "wait"; taskId: string; reason: string };
const SnapshotSchema = z.strictObject({
  // Version 3 persists dispatch mode and runtime identity. Older inactive
  // development snapshots cannot prove a runtime choice and fail closed.
  version: z.literal(3), controllerId: id, workerMode: z.enum(["direct", "runtime"]),
  tasks: z.array(TaskSchema).min(1).max(128),
  events: z.array(ControllerEventSchema).max(4096),
  notices: z.array(NoticeSchema).max(4096)
});
export type ControllerSnapshot = z.infer<typeof SnapshotSchema>;

function invalid(): never { throw Error("CONTROLLER_STATE_INVALID"); }
export function parseControllerEvent(value: unknown): ControllerEvent {
  const parsed = ControllerEventSchema.safeParse(value);
  if (!parsed.success) throw Error("CONTROLLER_EVENT_INVALID");
  const event = parsed.data;
  if (event.type === "worker_exited" && (event.reason === "external_wait") !== !!event.externalId)
    throw Error("CONTROLLER_EVENT_INVALID");
  return event;
}
function dependenciesClear(state: ControllerSnapshot, task: ControllerTask): boolean {
  return task.dependencies.every(key => {
    const dependency = state.tasks.find(t => t.id === key);
    return dependency ? dependency.status === "DONE" : task.resolvedDependencies.includes(key);
  });
}
function completionClear(state: ControllerSnapshot, task: ControllerTask): boolean {
  return !!task.candidate && (!task.verifierRequired || task.accepted) &&
    dependenciesClear(state, task) && !task.ownerActions.length && !task.externalWaits.length &&
    task.conditions.every(key => task.satisfiedConditions.includes(key)) &&
    state.tasks.filter(child => child.parentId === task.id).every(child => child.status === "DONE") &&
    (!task.run || task.run.phase === "exited");
}
export function parseControllerSnapshot(value: unknown): ControllerSnapshot {
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success) invalid();
  const state = parsed.data;
  for (const list of [state.tasks, state.events, state.notices])
    if (new Set(list.map(item => item.id)).size !== list.length) invalid();
  for (const task of state.tasks) {
    if (task.parentId && !state.tasks.some(t => t.id === task.parentId)) invalid();
    if (task.attempts > task.maxAttempts || (task.run && task.run.id !== task.id + "." + task.attempts)) invalid();
    if (task.accepted && (!task.candidate || !task.verifierRequired || task.run?.role !== "verifier" || task.run.verdict !== "ACCEPT")) invalid();
    // Verification must not inherit the implementer's identity.
    if (task.run?.role === "verifier" && task.run.assignee !== null) invalid();
    if (state.workerMode === "direct" && (task.implementerRuntime || task.run?.runtime)) invalid();
    if (state.workerMode === "runtime" && task.run && task.run.phase !== "pending" && !task.run.runtime) invalid();
    if (task.resolvedDependencies.some(key => !task.dependencies.includes(key)) ||
        task.satisfiedConditions.some(key => !task.conditions.includes(key))) invalid();
    if (task.status === "DONE" && !completionClear(state, task)) invalid();
  }
  // Child completion and internal dependencies must form an acyclic graph.
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (task: ControllerTask): void => {
    if (visiting.has(task.id)) invalid();
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    const required = state.tasks.filter(t => t.parentId === task.id || task.dependencies.includes(t.id));
    required.forEach(visit);
    visiting.delete(task.id); visited.add(task.id);
  };
  state.tasks.forEach(visit);
  for (const event of state.events) {
    parseControllerEvent(event);
    if (!state.tasks.some(t => t.id === event.taskId)) invalid();
  }
  if (state.notices.some(n => !state.tasks.some(t => t.id === n.taskId))) invalid();
  return state;
}
export function createControllerState(controllerId: string, definitions: TaskDefinition[], workerMode: ControllerSnapshot["workerMode"] = "direct"): ControllerSnapshot {
  const tasks = definitions.map(definition => ({
    ...TaskDefinitionSchema.parse(definition), status: "READY", attempts: 0, run: null,
    candidate: null, accepted: false, retryRequested: false, resolvedDependencies: [], satisfiedConditions: [], ownerActions: [], externalWaits: [], implementerRuntime: null
  }));
  return parseControllerSnapshot({ version: 3, controllerId, workerMode, tasks, events: [], notices: [] });
}
function notice(state: ControllerSnapshot, value: Omit<ControllerNotice, "delivered">): void {
  if (!state.notices.some(n => n.id === value.id)) state.notices.push({ ...value, delivered: false });
}
const MAX_HISTORY = 4096;
// Only receipts whose replay is already a guaranteed no-op may be dropped: a DONE
// task ignores every event, and run-scoped evidence for a superseded attempt is
// refused by the stale-run check. Gate, owner, external and retry receipts can
// still change a live task, so they are always kept.
function replayIsNoop(state: ControllerSnapshot, event: ControllerEvent): boolean {
  const task = state.tasks.find(t => t.id === event.taskId);
  if (!task) return true;
  if (task.status === "DONE") return true;
  return "runId" in event && event.runId !== task.run?.id;
}
// A delivered notice is dropped only when nothing can recreate its ID. The
// attempt-limit notice is re-emitted while its task sits at the budget.
function noticeIsSettled(state: ControllerSnapshot, value: ControllerNotice): boolean {
  if (!value.delivered) return false;
  if (value.reason !== "attempt_limit") return true;
  return state.tasks.find(t => t.id === value.taskId)?.status === "DONE";
}
function compactHistory(state: ControllerSnapshot): void {
  if (state.events.length >= MAX_HISTORY) state.events = state.events.filter(event => !replayIsNoop(state, event));
  if (state.notices.length >= MAX_HISTORY) state.notices = state.notices.filter(value => !noticeIsSettled(state, value));
}
export function applyControllerEvent(state: ControllerSnapshot, value: unknown): void {
  const event = parseControllerEvent(value);
  const previous = state.events.find(e => e.id === event.id);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(event)) throw Error("CONTROLLER_EVENT_ID_CONFLICT");
    return;
  }
  const task = state.tasks.find(t => t.id === event.taskId);
  if (!task) throw Error("CONTROLLER_TASK_UNKNOWN");
  if (state.events.length >= MAX_HISTORY) {
    compactHistory(state);
    // Still full means every receipt can still affect a live task; refuse the
    // event instead of silently losing idempotency evidence.
    if (state.events.length >= MAX_HISTORY) throw Error("CONTROLLER_HISTORY_FULL");
  }
  state.events.push(event);
  if (task.status === "DONE") return;
  if ("runId" in event && event.runId !== task.run?.id) return; // Stale worker, never a new attempt's evidence.
  switch (event.type) {
    case "worker_started":
    case "worker_progress":
      if (task.run && task.run.phase !== "exited") task.run.phase = "running";
      break;
    case "worker_exited":
      task.run!.phase = "exited";
      if (event.externalId && !task.externalWaits.includes(event.externalId)) task.externalWaits.push(event.externalId);
      break;
    case "candidate_ready":
      if (task.run!.role === "implementer") { task.candidate = event.runId; task.accepted = false; }
      break;
    case "verifier_result":
      if (task.run!.role !== "verifier" || !task.candidate) break;
      if (task.run!.verdict && task.run!.verdict !== event.result) throw Error("CONTROLLER_VERDICT_CONFLICT");
      task.run!.verdict = event.result;
      task.accepted = event.result === "ACCEPT";
      if (!task.accepted) task.candidate = null;
      break;
    case "dependency_resolved":
      if (event.kind === "dependency") {
        if (!task.dependencies.includes(event.key)) throw Error("CONTROLLER_GATE_UNKNOWN");
        if (!task.resolvedDependencies.includes(event.key)) task.resolvedDependencies.push(event.key);
      } else {
        if (!task.conditions.includes(event.key)) throw Error("CONTROLLER_GATE_UNKNOWN");
        if (!task.satisfiedConditions.includes(event.key)) task.satisfiedConditions.push(event.key);
      }
      break;
    case "owner_action_required":
      if (!task.ownerActions.includes(event.actionId)) task.ownerActions.push(event.actionId);
      notice(state, { id: event.id + ":notify", taskId: task.id, type: "notify_owner", reason: "B2" });
      break;
    case "owner_action_resolved":
      if (task.ownerActions.includes(event.actionId)) task.retryRequested = true;
      task.ownerActions = task.ownerActions.filter(key => key !== event.actionId);
      break;
    case "external_recovered":
      if (task.externalWaits.includes(event.externalId)) task.retryRequested = true;
      task.externalWaits = task.externalWaits.filter(key => key !== event.externalId);
      break;
    case "retry_due": task.retryRequested = true; break; // Never clears gates or replenishes a budget.
    // Applies to the next dispatch; a live attempt keeps the owner it was given.
    case "implementer_reassigned":
      if (task.assignee !== event.assignee) task.implementerRuntime = null;
      task.assignee = event.assignee;
      break;
  }
}
export function planController(state: ControllerSnapshot): ControllerAction[] {
  // A child may precede or follow its parent in the snapshot.
  for (let changed = true; changed;) {
    changed = false;
    for (const task of state.tasks) {
      if (task.status !== "DONE" && completionClear(state, task)) {
        task.status = "DONE"; changed = true;
        notice(state, { id: task.id + ":complete", taskId: task.id, type: "complete", reason: "accepted" });
        if (task.parentId) notice(state, { id: task.id + ":parent", taskId: task.parentId, type: "resume_parent", reason: "child_done" });
      }
    }
  }
  const actions: ControllerAction[] = [];
  for (const task of state.tasks) {
    if (task.status === "DONE") continue;
    let reason: string | undefined;
    if (task.ownerActions.length) { task.status = "NEEDS_USER"; reason = "owner"; }
    else if (task.externalWaits.length) { task.status = "WAIT_EXTERNAL"; reason = "external"; }
    else if (!dependenciesClear(state, task)) { task.status = "BLOCKED_DEPENDENCY"; reason = "dependency"; }
    else if (task.run && task.run.phase !== "exited") {
      task.retryRequested = false;
      task.status = task.run.role === "verifier" || (task.candidate && task.verifierRequired) ? "VERIFYING" : "WORKING";
      if (task.run.phase !== "pending") reason = task.run.phase === "unknown" ? "unknown_worker" : "active";
    } else if (task.candidate && (!task.verifierRequired || task.accepted)) {
      task.status = "BLOCKED_DEPENDENCY"; reason = "completion_gate";
    } else if (task.run?.phase === "exited" && !task.retryRequested &&
        ((task.run.role === "implementer" && !task.candidate) || (task.run.role === "verifier" && !task.run.verdict))) {
      // Exit/status can precede its durable result. Keep the identity until a
      // result arrives or an explicit bounded retry_due supersedes this attempt.
      task.status = task.run.role === "verifier" ? "VERIFYING" : "READY"; reason = "awaiting_result";
    } else if (task.attempts >= task.maxAttempts) {
      task.status = "NEEDS_USER"; reason = "attempt_limit";
      notice(state, { id: task.id + ":budget", taskId: task.id, type: "notify_owner", reason: "attempt_limit" });
    } else {
      const role = task.candidate ? "verifier" : "implementer";
      task.attempts++; task.retryRequested = false;
      // Repair reuses the current implementer; verification stays independent.
      task.run = { id: task.id + "." + task.attempts, role, phase: "pending", verdict: null,
        assignee: role === "implementer" ? task.assignee : null, runtime: null };
      task.status = role === "verifier" ? "VERIFYING" : "WORKING";
    }
    if (reason) {
      task.retryRequested = false;
      actions.push({ type: "wait", taskId: task.id, reason });
    }
    else if (task.run?.phase === "pending") {
      // Nothing has been launched yet, so a reassignment that arrived after this
      // attempt was reserved still routes to the current implementer.
      if (task.run.role === "implementer") task.run.assignee = task.assignee;
      actions.push({
        type: task.run.role === "verifier" ? "dispatch_verifier" : "dispatch_implementer",
        id: task.run.id, taskId: task.id, resources: [...task.resources], assignee: task.run.assignee
      });
    }
  }
  compactHistory(state); // Completed tasks and superseded attempts free their receipts here.
  return actions;
}
