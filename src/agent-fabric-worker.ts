import { z } from "zod";
import { FabricId, FabricUtc, FabricTimelineSchema } from "./agent-fabric-timeline.js";
import { LOCAL_RUNTIME_PROVIDERS } from "./controller-runtime-router.js";

const fact = <T extends z.ZodType>(value: T) => z.strictObject({ value, confirmedAt: FabricUtc,
  evidenceRef: FabricId, source: z.enum(["registered_integration", "adapter_receipt"]) });
export const WorkerAttributionSchema = z.strictObject({
  provider: fact(z.enum(["openai", "anthropic", "cursor"])).nullable().default(null),
  runtime: fact(z.enum(["codex", "claude-code", "cursor-agent"])).nullable().default(null),
  model: fact(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/)).nullable().default(null)
});
export type WorkerAttribution = z.infer<typeof WorkerAttributionSchema>;
export const FabricWorkerSchema = z.strictObject({
  workerId: z.string().uuid(), key: FabricId, controllerId: FabricId,
  parentWorkerId: z.string().uuid().nullable(),
  device: z.strictObject({ deviceId: FabricId, enrollmentEvidenceRef: FabricId }).nullable(),
  runtimeId: z.string().regex(/^rt-[0-9a-f-]{36}$/).nullable(),
  attribution: WorkerAttributionSchema,
  createdAt: FabricUtc, updatedAt: FabricUtc
});
export type FabricWorker = z.infer<typeof FabricWorkerSchema>;
export const FabricPayloadRefSchema = z.strictObject({ id: FabricId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(4 * 1024 * 1024) });
export type FabricPayloadRef = z.infer<typeof FabricPayloadRefSchema>;
export const FabricExecutionLinkSchema = z.strictObject({
  sessionId: FabricId.nullable(), pid: z.number().int().positive().max(0xffffffff).nullable(),
  executionId: z.string().uuid().toLowerCase().nullable().default(null),
  confirmedAt: FabricUtc, evidenceRef: FabricId
}).refine(link => link.sessionId !== null || link.pid !== null || link.executionId !== null);
export const FabricAssignmentSchema = z.strictObject({
  assignmentId: z.string().uuid(), workerId: z.string().uuid(), taskId: FabricId,
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), role: z.enum(["implementer", "verifier"]),
  selectedRuntime: z.enum(LOCAL_RUNTIME_PROVIDERS), payloadRef: FabricPayloadRefSchema,
  phase: z.enum(["assigned", "launching", "running", "unknown", "exited", "not_started"]),
  createdAt: FabricUtc, updatedAt: FabricUtc, timeline: FabricTimelineSchema, attribution: WorkerAttributionSchema,
  execution: FabricExecutionLinkSchema.nullable()
});
export type FabricAssignment = z.infer<typeof FabricAssignmentSchema>;
export function assignmentActive(assignment: FabricAssignment): boolean {
  return assignment.phase !== "exited" && assignment.phase !== "not_started";
}
