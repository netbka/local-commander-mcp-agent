import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandPreview, commandSummary, contextSummary, type MonitorContext } from "../packages/agent-cli/bin/monitor-context.mjs";
import type { ExecutionScheduler } from "./scheduler.js";
import type { ProcessManager } from "./process.js";

export interface ActivityAgent { runtimeId: string; name: string; model: string | null; activity: string | null; phase: string; taskId: string | null; project: string | null }
type Call = { id: number; tool: string; command: string; preview: string; state: string; at: number; agent: ActivityAgent | null; context: MonitorContext; batchChild: boolean };
type Metric = { tool: string; calls: number; errors: number; sentBytes: number; savedBytes: number; outputBytes: number; durationMs: number };
type Event = { id: number; at: string; tool: string; command: string; preview: string; model: string | null; exitCode: number | null; timedOut: boolean; state: string; agent: string | null; name: string | null; context: MonitorContext; code: string | null; durationMs: number; sentBytes: number; savedBytes: number };

/** Bounded facts only; diagnostics never block or change a tool result. */
export class McpActivityMonitor {
  private readonly instanceId = randomUUID();
  private readonly calls = new Map<number, Call>();
  private readonly metrics = new Map<string, Metric>();
  private readonly agents = new Map<string, Metric & { runtimeId: string; name: string; model: string | null }>();
  private readonly events: Event[] = [];
  private readonly transitions: Array<{ seq: number; id: number; at: string; tool: string; preview: string; state: "running"; context: MonitorContext; name: string | null; model: string | null }> = [];
  private sequence = 0;
  private scheduler?: ExecutionScheduler;
  private processes?: ProcessManager;
  private readonly managed = new Map<string, { agent: ActivityAgent | null; context: MonitorContext }>();
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private dirty = false;
  private dropped = 0;
  private writeErrors = 0;
  private writes = 0;
  private readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, `${process.pid}-${this.instanceId}.json`); }
  setScheduler(scheduler: ExecutionScheduler, processes?: ProcessManager): void { this.scheduler = scheduler; this.processes = processes; }
  manage(requestId: number, processId: string): void {
    const call = this.calls.get(requestId);
    if (call) {
      this.managed.set(processId, { agent: call.agent, context: call.context });
      if (this.managed.size > 64) this.managed.delete(this.managed.keys().next().value!);
      this.changed();
    }
  }
  start(id: number, tool: string, meta: Record<string, unknown>, agent: ActivityAgent | null): void {
    // ponytail: 256 in-flight observations and 100 completions; no full payload log or replay scan.
    if (this.calls.size >= 256) { this.dropped++; return; }
    this.calls.set(id, { id, tool, command: commandSummary(tool, meta), preview: commandPreview(tool, meta), state: "accepted", at: Date.now(), agent,
      context: contextSummary({ ...meta, taskId: agent?.taskId ?? meta.taskId, project: meta.cwd ?? meta.path ?? agent?.project }), batchChild: meta.batchParentRequestId !== undefined });
    this.changed();
  }
  running(id: number): void {
    const call = this.calls.get(id);
    if (call) {
      call.state = "running";
      this.transitions.push({ seq: ++this.sequence, id, at: new Date().toISOString(), tool: call.tool, preview: call.preview,
        state: "running", context: call.context, name: call.agent?.name ?? null, model: call.agent?.model ?? null });
      if (this.transitions.length > 100) this.transitions.shift();
      this.changed();
    }
  }
  bind(id: number, agent: ActivityAgent): void {
    const call = this.calls.get(id);
    if (call) { call.agent = agent; call.context = contextSummary({ ...call.context, taskId: agent.taskId, project: agent.project }); this.changed(); }
  }
  finish(id: number, result: unknown, savedBytes = 0, error?: unknown, responseBytes?: number): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const failed = error !== undefined || value.timedOut === true || (typeof value.exitCode === "number" && value.exitCode !== 0) || value.ok === false;
    const message = error instanceof Error ? error.message : "";
    const code = error !== undefined ? (/^[A-Z][A-Z0-9_]{0,63}$/.test(message) ? message : "TOOL_ERROR") : value.timedOut === true ? "TIMED_OUT" : failed ? "COMMAND_FAILED" : null;
    const durationMs = Math.max(0, Date.now() - call.at);
    // Child results are delivered in their parent's response; count the actual response once.
    const sentBytes = call.batchChild ? 0 : error !== undefined ? Buffer.byteLength(error instanceof Error ? error.message : String(error)) :
      responseBytes ?? Buffer.byteLength(JSON.stringify(result ?? null, null, 2));
    const outputBytes = [value.stdout, value.stderr, value.content].reduce<number>((sum, item) => sum + (typeof item === "string" ? Buffer.byteLength(item) : 0), 0);
    const metric = this.metrics.get(call.tool) ?? { tool: call.tool, calls: 0, errors: 0, sentBytes: 0, savedBytes: 0, outputBytes: 0, durationMs: 0 };
    metric.calls++; metric.errors += Number(failed); metric.sentBytes += sentBytes; metric.savedBytes += savedBytes; metric.outputBytes += outputBytes; metric.durationMs += durationMs;
    this.metrics.set(call.tool, metric);
    if (call.agent) {
      const key = call.agent.runtimeId + ":" + (call.agent.model ?? "");
      if (this.agents.has(key) || this.agents.size < 64) {
        const usage = this.agents.get(key) ?? { runtimeId: call.agent.runtimeId, name: call.agent.name, model: call.agent.model,
          tool: "all", calls: 0, errors: 0, sentBytes: 0, savedBytes: 0, outputBytes: 0, durationMs: 0 };
        usage.calls++; usage.errors += Number(failed); usage.sentBytes += sentBytes; usage.savedBytes += savedBytes; usage.outputBytes += outputBytes; usage.durationMs += durationMs;
        this.agents.set(key, usage);
      } else this.dropped++;
    }
    this.events.push({ id, at: new Date().toISOString(), tool: call.tool, command: call.command, preview: call.preview, model: call.agent?.model ?? null,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null, timedOut: value.timedOut === true, state: failed ? "failed" : "finished",
      agent: call.agent?.runtimeId ?? null, name: call.agent?.name ?? null, context: call.context, code, durationMs, sentBytes, savedBytes });
    if (this.events.length > 100) this.events.shift();
    this.changed();
  }
  snapshot() {
    const queue = this.scheduler?.snapshot().queued as Array<{ requestId: number }> | undefined;
    const queued = new Set(queue?.map(item => item.requestId));
    return { schemaVersion: 1, instanceId: this.instanceId, pid: process.pid, computer: os.hostname().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64),
      updatedAt: new Date().toISOString(), queue: queue?.length ?? null, dropped: this.dropped, writeErrors: this.writeErrors, writes: this.writes,
      calls: [...this.calls.values()].map(({ batchChild, ...call }) => ({ ...call, state: queued.has(call.id) ? "queued" : call.state })),
      processes: (this.processes?.list() ?? []).filter(item => item.running === true).slice(0, 64).map(item => ({
        id: item.id, pid: item.pid, command: commandSummary("process_start", item), preview: commandPreview("process_start", item), context: this.managed.get(String(item.id))?.context ?? contextSummary(item),
        agent: this.managed.get(String(item.id))?.agent ?? null
      })),
      agents: [...this.agents.values()].map(metric => ({ ...metric })),
      metrics: [...this.metrics.values()].map(metric => ({ ...metric })), events: this.events.slice(), transitions: this.transitions.slice() };
  }
  changed(): void {
    this.dirty = true;
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.writing) { await this.writing; if (this.dirty) await this.flush(); return; }
    if (!this.dirty) return;
    this.dirty = false;
    this.writing = (async () => {
      const directory = path.dirname(this.file);
      const temporary = this.file + ".tmp";
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("MONITOR_DIRECTORY_INVALID");
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(this.snapshot()) + "\n"); } finally { await handle.close(); }
        await rename(temporary, this.file); this.writes++;
      } catch { this.writeErrors++; }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    })().finally(() => { this.writing = undefined; if (this.dirty) this.changed(); });
    await this.writing;
  }
}
