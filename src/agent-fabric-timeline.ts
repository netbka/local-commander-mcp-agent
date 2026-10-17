import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";

export const FabricId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
export const FabricUtc = z.string().datetime({ precision: 3 }).refine(value => new Date(value).toISOString() === value);
export const FabricStampSchema = z.strictObject({ atUtc: FabricUtc, clockId: FabricId,
  monotonicMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type FabricStamp = z.infer<typeof FabricStampSchema>;
const processClockId = "clock-" + randomUUID();
export function createFabricClock(): () => FabricStamp {
  return () => ({ atUtc: new Date().toISOString(), clockId: processClockId, monotonicMs: performance.now() });
}
export const FABRIC_STAGES = ["admitted", "queued", "worker_started", "execution_started", "execution_finished", "result_received", "result_delivered"] as const;
export type FabricStage = typeof FABRIC_STAGES[number];
const MarkSchema = z.strictObject({ stamp: FabricStampSchema,
  source: z.enum(["cloud", "controller", "native", "adapter"]), evidenceRef: FabricId });
export type FabricTimingMark = z.infer<typeof MarkSchema>;
export const FabricTimelineSchema = z.strictObject({
  admitted: MarkSchema.nullable().default(null), queued: MarkSchema.nullable().default(null),
  worker_started: MarkSchema.nullable().default(null), execution_started: MarkSchema.nullable().default(null),
  execution_finished: MarkSchema.nullable().default(null), result_received: MarkSchema.nullable().default(null),
  result_delivered: MarkSchema.nullable().default(null)
});
export type FabricTimeline = z.infer<typeof FabricTimelineSchema>;
export function markFabricTimeline(timeline: FabricTimeline, stage: FabricStage, input: FabricTimingMark): void {
  if (!FABRIC_STAGES.includes(stage)) throw Error("FABRIC_TIMING_STAGE_INVALID");
  const mark = MarkSchema.parse(input), previous = timeline[stage];
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(mark)) throw Error("FABRIC_TIMING_CONFLICT");
    return;
  }
  const next = { ...timeline, [stage]: mark };
  const clocks = new Map<string, number>();
  for (const name of FABRIC_STAGES) {
    const stamp = next[name]?.stamp;
    if (!stamp) continue;
    const before = clocks.get(stamp.clockId);
    if (before !== undefined && stamp.monotonicMs < before) throw Error("FABRIC_TIMING_ORDER_INVALID");
    clocks.set(stamp.clockId, stamp.monotonicMs);
  }
  timeline[stage] = mark;
}
export function fabricDurations(timeline: FabricTimeline) {
  const elapsed = (start: FabricStage, end: FabricStage): number | null => {
    const a = timeline[start]?.stamp, b = timeline[end]?.stamp;
    return a && b && a.clockId === b.clockId && b.monotonicMs >= a.monotonicMs ? b.monotonicMs - a.monotonicMs : null;
  };
  // Never subtract UTC timestamps from independent hosts or process incarnations.
  return { admissionMs: elapsed("admitted", "queued"), queueWaitMs: elapsed("queued", "worker_started"),
    workerStartupMs: elapsed("worker_started", "execution_started"), executionMs: elapsed("execution_started", "execution_finished"),
    resultTransitMs: elapsed("execution_finished", "result_received"), resultDeliveryMs: elapsed("result_received", "result_delivered"),
    totalMs: elapsed("admitted", "result_delivered") };
}
