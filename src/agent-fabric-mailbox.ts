import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentRuntimeIdentityStore, type RuntimeCredential } from "./agent-runtime-identity.js";
import { FabricStateFile } from "./agent-fabric-state.js";
import { FabricId, FabricUtc, FabricTimelineSchema, createFabricClock, markFabricTimeline,
  type FabricStage, type FabricTimingMark } from "./agent-fabric-timeline.js";
import { FabricWorkerSchema, FabricAssignmentSchema, FabricPayloadRefSchema, FabricExecutionLinkSchema, WorkerAttributionSchema,
  assignmentActive, type FabricAssignment, type FabricPayloadRef, type FabricWorker, type WorkerAttribution } from "./agent-fabric-worker.js";

const MAX_WORKERS = 64, MAX_ASSIGNMENTS = 256, MAX_MESSAGES = 1024, MAX_TTL_MS = 86_400_000;
const Control = z.enum(["CANCEL", "WAKE"]), Report = z.enum(["PROGRESS", "BLOCKED", "RESULT"]);
const MessageSchema = z.strictObject({
  messageId: z.string().uuid(), key: FabricId, assignmentId: z.string().uuid(),
  origin: z.enum(["controller", "worker", "adapter"]),
  direction: z.enum(["to_worker", "to_controller"]), kind: z.enum(["ASSIGN", ...Control.options, ...Report.options]),
  payloadRef: FabricPayloadRefSchema, createdAt: FabricUtc, expiresAt: FabricUtc, acknowledgedAt: FabricUtc.nullable()
});
export type FabricMessage = z.infer<typeof MessageSchema>;
const StateSchema = z.strictObject({ version: z.literal(2), controllerId: FabricId,
  workers: z.array(FabricWorkerSchema).max(MAX_WORKERS), assignments: z.array(FabricAssignmentSchema).max(MAX_ASSIGNMENTS),
  messages: z.array(MessageSchema).max(MAX_MESSAGES) });
type State = z.infer<typeof StateSchema>;
export interface FabricPendingNotice {
  controllerId: string; workerId: string; assignmentId: string; messageId: string;
  direction: FabricMessage["direction"]; kind: FabricMessage["kind"]; expiresAt: string;
  origin: FabricMessage["origin"];
}
const Registration = z.strictObject({ key: FabricId, parentWorkerId: z.string().uuid().nullable().default(null),
  device: FabricWorkerSchema.shape.device.default(null) });
const AssignmentInput = FabricAssignmentSchema.pick({ workerId: true, taskId: true, runId: true,
  role: true, selectedRuntime: true, payloadRef: true });
const MessageInput = z.strictObject({ key: FabricId, payloadRef: FabricPayloadRefSchema,
  ttlMs: z.number().int().min(1000).max(MAX_TTL_MS).default(60_000) });
const ConfirmInput = z.strictObject({
  provider: WorkerAttributionSchema.shape.provider.removeDefault().optional(),
  runtime: WorkerAttributionSchema.shape.runtime.removeDefault().optional(),
  model: WorkerAttributionSchema.shape.model.removeDefault().optional()
});

function parseState(value: unknown): State {
  const state = StateSchema.parse(value);
  for (const values of [state.workers.map(w => w.workerId), state.workers.map(w => w.key),
    state.assignments.map(a => a.assignmentId), state.assignments.map(a => JSON.stringify([a.runId, a.selectedRuntime])),
    state.assignments.flatMap(a => a.execution?.executionId ? [a.execution.executionId] : []),
    state.messages.map(m => m.messageId), state.messages.map(m => JSON.stringify([m.assignmentId, m.origin, m.key]))])
    if (new Set(values).size !== values.length) throw Error("FABRIC_STATE_CORRUPT");
  for (const worker of state.workers) {
    if (worker.controllerId !== state.controllerId) throw Error("FABRIC_STATE_CORRUPT");
    const seen = new Set([worker.workerId]);
    let parent = worker.parentWorkerId;
    while (parent) {
      if (seen.has(parent)) throw Error("FABRIC_STATE_CORRUPT");
      seen.add(parent);
      const ancestor = state.workers.find(w => w.workerId === parent);
      if (!ancestor) throw Error("FABRIC_STATE_CORRUPT");
      parent = ancestor.parentWorkerId;
    }
  }
  const activeWorkers = new Set<string>(), activeRuns = new Set<string>();
  for (const assignment of state.assignments) {
    if (!state.workers.some(w => w.workerId === assignment.workerId)) throw Error("FABRIC_STATE_CORRUPT");
    if (assignmentActive(assignment)) {
      if (activeWorkers.has(assignment.workerId) || activeRuns.has(assignment.runId)) throw Error("FABRIC_STATE_CORRUPT");
      activeWorkers.add(assignment.workerId); activeRuns.add(assignment.runId);
    }
    const validated = FabricTimelineSchema.parse({});
    for (const [stage, mark] of Object.entries(assignment.timeline))
      if (mark) markFabricTimeline(validated, stage as FabricStage, mark);
  }
  for (const message of state.messages) {
    if (!state.assignments.some(a => a.assignmentId === message.assignmentId) || message.expiresAt <= message.createdAt ||
        Date.parse(message.expiresAt) - Date.parse(message.createdAt) > MAX_TTL_MS ||
        (message.direction === "to_worker") !== ["ASSIGN", "CANCEL", "WAKE"].includes(message.kind) ||
        (message.direction === "to_worker") !== (message.origin === "controller") ||
        (message.origin === "adapter" && message.kind !== "RESULT")) throw Error("FABRIC_STATE_CORRUPT");
  }
  return state;
}

/** Trusted controller-owned service, NOT an MCP request schema. Device/parent/attribution
 * mutations must stay behind the coordinator's authenticated authority. Workers only get
 * the credential-checked inbox/report/ACK methods and cannot address another worker. */
export class AgentWorkerMailbox {
  private readonly state: FabricStateFile<State>;
  private readonly controllerId: string;
  constructor(file: string, controllerId: string, private readonly identities: AgentRuntimeIdentityStore,
    private readonly clock = createFabricClock(), private readonly notify?: (notice: FabricPendingNotice) => void | Promise<void>) {
    this.controllerId = FabricId.parse(controllerId);
    this.state = new FabricStateFile(file, 2 * 1024 * 1024, value => {
      const state = parseState(value);
      if (state.controllerId !== this.controllerId) throw Error("FABRIC_CONTROLLER_MISMATCH");
      return state;
    });
  }
  initialize(): Promise<void> {
    let created = false;
    return this.state.update(() => { if (!created) throw Error("FABRIC_STATE_EXISTS"); }, () => {
      created = true; return { version: 2, controllerId: this.controllerId, workers: [], assignments: [], messages: [] };
    });
  }
  private worker(state: State, id: string): FabricWorker {
    const worker = state.workers.find(w => w.workerId === id);
    if (!worker) throw Error("FABRIC_WORKER_UNKNOWN");
    return worker;
  }
  private assignment(state: State, id: string): FabricAssignment {
    const assignment = state.assignments.find(a => a.assignmentId === id);
    if (!assignment) throw Error("FABRIC_ASSIGNMENT_UNKNOWN");
    return assignment;
  }
  private bound(state: State, workerId: string, credential: RuntimeCredential): FabricWorker {
    const worker = this.worker(state, workerId);
    if (worker.runtimeId !== credential.runtimeId) throw Error("FABRIC_WORKER_DENIED");
    return worker;
  }
  private emit(state: State, message: FabricMessage): void {
    const assignment = this.assignment(state, message.assignmentId);
    try { void Promise.resolve(this.notify?.({ controllerId: this.controllerId, workerId: assignment.workerId,
      assignmentId: assignment.assignmentId, messageId: message.messageId, direction: message.direction,
      kind: message.kind, origin: message.origin, expiresAt: message.expiresAt })).catch(() => {}); }
    catch { /* Observer/transport failures never change committed mailbox truth or ordinary execution. */ }
  }
  register(input: z.input<typeof Registration>): Promise<FabricWorker> {
    const registration = Registration.parse(input);
    return this.state.update(state => {
      const existing = state.workers.find(w => w.key === registration.key);
      if (existing) {
        if (existing.parentWorkerId !== registration.parentWorkerId || JSON.stringify(existing.device) !== JSON.stringify(registration.device))
          throw Error("FABRIC_WORKER_ID_CONFLICT");
        return existing;
      }
      if (state.workers.length >= MAX_WORKERS) throw Error("FABRIC_WORKER_LIMIT");
      if (registration.parentWorkerId) this.worker(state, registration.parentWorkerId);
      const now = this.clock().atUtc;
      const worker: FabricWorker = { ...registration, workerId: randomUUID(), controllerId: this.controllerId,
        runtimeId: null, attribution: WorkerAttributionSchema.parse({}), createdAt: now, updatedAt: now };
      state.workers.push(worker); return worker;
    });
  }
  async bindRuntime(workerId: string, credential: RuntimeCredential): Promise<void> {
    await this.identities.authenticate(credential.runtimeId, credential.runtimeKey);
    await this.state.update(state => {
      const worker = this.worker(state, workerId);
      if (worker.runtimeId !== credential.runtimeId) {
        worker.runtimeId = credential.runtimeId;
        worker.attribution = WorkerAttributionSchema.parse({});
        worker.updatedAt = this.clock().atUtc;
      }
    });
  }
  private append(state: State, assignment: FabricAssignment, kind: FabricMessage["kind"], origin: FabricMessage["origin"],
    input: z.input<typeof MessageInput>): { message: FabricMessage; added: boolean } {
    const request = MessageInput.parse(input);
    const direction = origin === "controller" ? "to_worker" : "to_controller";
    if (kind === "RESULT" && request.key !== "result") throw Error("FABRIC_RESULT_KEY_INVALID");
    const existing = state.messages.find(m => m.assignmentId === assignment.assignmentId && m.origin === origin && m.key === request.key);
    if (existing) {
      if (existing.kind !== kind || JSON.stringify(existing.payloadRef) !== JSON.stringify(request.payloadRef) ||
          Date.parse(existing.expiresAt) - Date.parse(existing.createdAt) !== request.ttlMs) throw Error("FABRIC_MESSAGE_ID_CONFLICT");
      return { message: existing, added: false }; // Neither replay nor ACK renews expiry.
    }
    // ponytail: bounded retained ledger; explicit reviewed archival is required at capacity, never evict unknown work.
    if (state.messages.length >= MAX_MESSAGES) throw Error("FABRIC_MESSAGE_LIMIT");
    const now = this.clock();
    const message: FabricMessage = { messageId: randomUUID(), key: request.key, assignmentId: assignment.assignmentId,
      direction, origin, kind, payloadRef: request.payloadRef, createdAt: now.atUtc,
      expiresAt: new Date(Date.parse(now.atUtc) + request.ttlMs).toISOString(), acknowledgedAt: null };
    state.messages.push(message);
    if (origin === "adapter") markFabricTimeline(assignment.timeline, "result_received", { stamp: now, source: "controller", evidenceRef: message.messageId });
    return { message, added: true };
  }
  async assign(input: z.input<typeof AssignmentInput>): Promise<FabricAssignment> {
    const request = AssignmentInput.parse(input);
    const saved = await this.state.update(state => {
      this.worker(state, request.workerId);
      const existing = state.assignments.find(a => a.runId === request.runId && a.selectedRuntime === request.selectedRuntime);
      if (existing) {
        if (JSON.stringify(AssignmentInput.strip().parse(existing)) !== JSON.stringify(request)) throw Error("FABRIC_ASSIGNMENT_ID_CONFLICT");
        return { state, assignment: existing, notice: null };
      }
      if (state.assignments.length >= MAX_ASSIGNMENTS) throw Error("FABRIC_ASSIGNMENT_LIMIT");
      if (state.assignments.some(a => assignmentActive(a) && (a.workerId === request.workerId || a.runId === request.runId)))
        throw Error("FABRIC_WORKER_BUSY");
      const now = this.clock().atUtc;
      const assignment: FabricAssignment = { ...request, assignmentId: randomUUID(), phase: "assigned",
        createdAt: now, updatedAt: now, timeline: FabricTimelineSchema.parse({}), attribution: WorkerAttributionSchema.parse({}), execution: null };
      const worker = this.worker(state, request.workerId);
      worker.attribution = WorkerAttributionSchema.parse({}); worker.updatedAt = now;
      state.assignments.push(assignment);
      const { message } = this.append(state, assignment, "ASSIGN", "controller", { key: "assign", payloadRef: request.payloadRef });
      return { state, assignment, notice: message };
    });
    if (saved.notice) this.emit(saved.state, saved.notice);
    return saved.assignment;
  }
  async control(assignmentId: string, kind: z.infer<typeof Control>, input: z.input<typeof MessageInput>): Promise<FabricMessage> {
    Control.parse(kind);
    const saved = await this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      if (!assignmentActive(assignment)) throw Error("FABRIC_ASSIGNMENT_INACTIVE");
      return { state, ...this.append(state, assignment, kind, "controller", input) };
    });
    if (saved.added) this.emit(saved.state, saved.message);
    return saved.message;
  }
  async report(workerId: string, credential: RuntimeCredential, assignmentId: string, kind: z.infer<typeof Report>,
    input: z.input<typeof MessageInput>): Promise<FabricMessage> {
    Report.parse(kind);
    await this.identities.authenticate(credential.runtimeId, credential.runtimeKey);
    const saved = await this.state.update(state => {
      this.bound(state, workerId, credential);
      const assignment = this.assignment(state, assignmentId);
      if (assignment.workerId !== workerId || assignment.phase === "not_started") throw Error("FABRIC_ASSIGNMENT_DENIED");
      return { state, ...this.append(state, assignment, kind, "worker", input) };
    });
    if (saved.added) this.emit(saved.state, saved.message);
    return saved.message;
  }
  private pending(state: State, direction: FabricMessage["direction"], workerId?: string): FabricMessage[] {
    const now = this.clock().atUtc;
    return state.messages.filter(m => m.direction === direction && !m.acknowledgedAt && m.expiresAt > now &&
      (direction !== "to_worker" || state.assignments.some(a => a.assignmentId === m.assignmentId && a.workerId === workerId && assignmentActive(a))));
  }
  async inbox(workerId: string, credential: RuntimeCredential, limit = 32): Promise<FabricMessage[]> {
    z.number().int().min(1).max(64).parse(limit);
    await this.identities.authenticate(credential.runtimeId, credential.runtimeKey);
    const state = await this.state.read(); this.bound(state, workerId, credential);
    return this.pending(state, "to_worker", workerId).slice(0, limit);
  }
  async controllerInbox(limit = 32): Promise<FabricMessage[]> {
    z.number().int().min(1).max(64).parse(limit);
    return this.pending(await this.state.read(), "to_controller").slice(0, limit);
  }
  private acknowledge(state: State, messageId: string, direction: FabricMessage["direction"], workerId?: string): boolean {
    const message = state.messages.find(m => m.messageId === messageId && m.direction === direction);
    if (!message) return false;
    const assignment = this.assignment(state, message.assignmentId);
    if (direction === "to_worker" && assignment.workerId !== workerId) return false;
    if (message.acknowledgedAt) return true;
    const now = this.clock();
    if (message.expiresAt <= now.atUtc) return false;
    message.acknowledgedAt = now.atUtc;
    if (message.origin === "adapter") markFabricTimeline(assignment.timeline, "result_delivered", { stamp: now, source: "controller", evidenceRef: message.messageId });
    return true;
  }
  async ack(workerId: string, credential: RuntimeCredential, messageId: string): Promise<boolean> {
    await this.identities.authenticate(credential.runtimeId, credential.runtimeKey);
    return this.state.update(state => { this.bound(state, workerId, credential); return this.acknowledge(state, messageId, "to_worker", workerId); });
  }
  controllerAck(messageId: string): Promise<boolean> {
    return this.state.update(state => this.acknowledge(state, messageId, "to_controller"));
  }
  async adapterResult(assignmentId: string, payloadRef: FabricPayloadRef): Promise<void> {
    const saved = await this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      if (assignment.phase !== "exited") throw Error("FABRIC_RESULT_UNCONFIRMED");
      return { state, ...this.append(state, assignment, "RESULT", "adapter", { key: "result", payloadRef }) };
    });
    if (saved.added) this.emit(saved.state, saved.message);
  }
  claimLaunch(assignmentId: string): Promise<boolean> {
    return this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      if (assignment.phase !== "assigned" && assignment.phase !== "not_started") return false;
      assignment.phase = "launching"; assignment.updatedAt = this.clock().atUtc;
      return true;
    });
  }
  timing(assignmentId: string, stage: FabricStage, mark: FabricTimingMark): Promise<void> {
    return this.state.update(state => { markFabricTimeline(this.assignment(state, assignmentId).timeline, stage, mark); });
  }
  confirmExecution(assignmentId: string, input: z.input<typeof FabricExecutionLinkSchema>): Promise<void> {
    const execution = FabricExecutionLinkSchema.parse(input);
    return this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      if (assignment.execution && JSON.stringify(assignment.execution) !== JSON.stringify(execution)) throw Error("FABRIC_EXECUTION_CONFLICT");
      if (execution.executionId && state.assignments.some(a => a.assignmentId !== assignmentId && a.execution?.executionId === execution.executionId))
        throw Error("FABRIC_EXECUTION_CONFLICT");
      assignment.execution = execution;
    });
  }
  /** Trusted transport adapter passes its authenticated device, never a worker-reported label.
   * References remain device-reported diagnostics in the cloud, not ownership/authentication. */
  async incidentReferences(deviceId: string, executionId: string): Promise<{ executionId: string; workerId: string; taskId?: string } | null> {
    FabricId.parse(deviceId);
    const execution = z.string().uuid().toLowerCase().parse(executionId);
    const state = await this.state.read();
    const assignment = state.assignments.find(a => a.execution?.executionId === execution);
    if (!assignment || this.worker(state, assignment.workerId).device?.deviceId !== deviceId) return null;
    const task = z.string().uuid().toLowerCase().safeParse(assignment.taskId);
    return { executionId: execution, workerId: assignment.workerId, ...(task.success ? { taskId: task.data } : {}) };
  }
  confirmAttribution(assignmentId: string, input: Partial<WorkerAttribution>): Promise<void> {
    const confirmed = ConfirmInput.parse(input);
    for (const key of ["provider", "runtime", "model"] as const)
      if (confirmed[key] === undefined) delete confirmed[key];
    return this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      for (const key of ["provider", "runtime", "model"] as const)
        if (assignment.attribution[key] && confirmed[key] !== undefined &&
            JSON.stringify(assignment.attribution[key]) !== JSON.stringify(confirmed[key])) throw Error("FABRIC_ATTRIBUTION_CONFLICT");
      Object.assign(assignment.attribution, confirmed);
      const latest = state.assignments.filter(a => a.workerId === assignment.workerId).at(-1);
      if (latest?.assignmentId === assignmentId) Object.assign(this.worker(state, assignment.workerId).attribution, confirmed);
    });
  }
  phase(assignmentId: string, next: FabricAssignment["phase"]): Promise<void> {
    return this.state.update(state => {
      const assignment = this.assignment(state, assignmentId);
      const allowed = { assigned: ["launching", "not_started", "unknown"], launching: ["running", "not_started", "unknown", "exited"],
        running: ["unknown", "exited"], unknown: ["exited"], exited: [], not_started: ["launching"] };
      if (assignment.phase === next) return;
      if (!(allowed[assignment.phase] as string[]).includes(next)) throw Error("FABRIC_ASSIGNMENT_PHASE_INVALID");
      assignment.phase = next; assignment.updatedAt = this.clock().atUtc;
    });
  }
  async snapshot() {
    const state = await this.state.read(), now = this.clock().atUtc;
    const nextExpiry = state.messages.filter(m => !m.acknowledgedAt && m.expiresAt > now)
      .reduce<string | null>((next, m) => next === null || m.expiresAt < next ? m.expiresAt : next, null);
    return { ...state, nextExpiry }; // One next deadline for the existing event supervisor; no timer here.
  }
}
