import { randomUUID } from "node:crypto";
import { agentName } from "../packages/agent-cli/bin/monitor-context.mjs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Local half of the Agent Fabric (planning/AGENT_FABRIC.md): runtime presence and
// controller-mediated task messaging. Facts only. Nothing here grants authority:
// a message can never move a permission, lease or task assignment, and a
// capability string is a display/routing hint, never a permission.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
const text = (max: number) => z.string().max(max).refine(v => !/[\p{Cc}]/u.test(v.replace(/\n/g, "")));
const MAX_RUNTIMES = 64;
const MAX_MESSAGES = 512;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 30 * 60_000;
const MAX_MESSAGE_MS = 24 * 60 * 60_000;

export const RuntimeHealth = ["active", "stale", "lost", "stopped"] as const;
export type RuntimeHealth = (typeof RuntimeHealth)[number];

const RuntimeSchema = z.strictObject({
  id,
  // Self-reported display metadata. Never an identity or a permission.
  label: text(80),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,7}$/).optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$/).nullable().optional(),
  project: text(96).nullable().optional(),
  phase: z.enum(["working", "analysis", "message", "idle"]).optional(),
  source: z.enum(["remote_web", "local_ide", "local_cli", "managed_worker", "unknown"]),
  node: text(80),
  capabilities: z.array(text(40)).max(32),
  taskId: id.nullable(),
  // What it is doing right now, for the monitor only.
  activity: text(160).nullable(),
  stopped: z.boolean(),
  registeredAt: z.number().int().positive(),
  lastSeenAt: z.number().int().positive(),
  leaseMs: z.number().int().min(1000).max(MAX_LEASE_MS)
});
export type AgentRuntime = z.infer<typeof RuntimeSchema>;

const MessageSchema = z.strictObject({
  id,
  taskId: id,
  from: id,
  // A runtime ID or a role mailbox, so a handoff survives the peer disconnecting.
  to: id,
  kind: z.enum(["status", "question", "answer", "handoff", "result_summary", "blocker"]),
  // Untrusted input. Never interpreted as a controller command.
  body: text(4000),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  ackedBy: z.array(id).max(MAX_RUNTIMES)
});
export type AgentMessage = z.infer<typeof MessageSchema>;

const StateSchema = z.strictObject({
  version: z.literal(1),
  runtimes: z.array(RuntimeSchema).max(MAX_RUNTIMES),
  messages: z.array(MessageSchema).max(MAX_MESSAGES)
});
export type FabricState = z.infer<typeof StateSchema>;

export interface RuntimeView extends AgentRuntime {
  health: RuntimeHealth;
  idleMs: number;
  unreadCount: number;
}
export interface FabricSnapshot {
  generatedAt: number;
  runtimes: RuntimeView[];
  messages: AgentMessage[];
}

export function parseFabricState(value: unknown): FabricState {
  const parsed = StateSchema.safeParse(value);
  if (!parsed.success) throw Error("FABRIC_STATE_INVALID");
  const state = parsed.data;
  for (const list of [state.runtimes, state.messages])
    if (new Set(list.map(item => item.id)).size !== list.length) throw Error("FABRIC_STATE_INVALID");
  for (const message of state.messages)
    if (message.expiresAt <= message.createdAt) throw Error("FABRIC_STATE_INVALID");
  return state;
}
export function emptyFabricState(): FabricState {
  return { version: 1, runtimes: [], messages: [] };
}
export function runtimeHealth(runtime: AgentRuntime, now: number): RuntimeHealth {
  if (runtime.stopped) return "stopped";
  const overdue = now - runtime.lastSeenAt;
  if (overdue <= runtime.leaseMs) return "active";
  // One missed lease is a slow turn; beyond that the runtime is not reporting.
  return overdue <= runtime.leaseMs * 3 ? "stale" : "lost";
}
// A lost runtime's work is never assumed finished; this only drops its record.
function prune(state: FabricState, now: number): void {
  state.messages = state.messages.filter(message => message.expiresAt > now);
  if (state.messages.length > MAX_MESSAGES)
    state.messages = state.messages.slice(state.messages.length - MAX_MESSAGES);
  const retired = state.runtimes
    .filter(runtime => runtimeHealth(runtime, now) === "stopped" || runtimeHealth(runtime, now) === "lost")
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  while (state.runtimes.length > MAX_RUNTIMES - 1 && retired.length) {
    const drop = retired.shift()!;
    state.runtimes = state.runtimes.filter(runtime => runtime.id !== drop.id);
  }
}

export interface AnnounceInput {
  runtimeId?: string;
  label: string;
  source: AgentRuntime["source"];
  node: string;
  capabilities?: string[];
  leaseMs?: number;
  model?: string | null;
  project?: string | null;
  phase?: AgentRuntime["phase"];
}
export interface ReportInput {
  runtimeId: string;
  activity?: string | null;
  taskId?: string | null;
  stopped?: boolean;
}
export interface SendInput {
  messageId?: string;
  taskId: string;
  from: string;
  to: string;
  kind: AgentMessage["kind"];
  body: string;
  ttlMs?: number;
}

// Fabric state is Local Commander's own state, so it lives under the protected
// `.local-commander` directory and is written directly rather than through
// PathGuard. That is deliberate: the guard blocks that directory precisely so no
// agent can read or rewrite coordination state through the file tools.
export async function writeServerStateFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

export class AgentFabric {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  // All callers reach one MCP server process, so an in-process queue plus an
  // atomic commit is the whole concurrency story. No cross-process lock exists.
  private serial<T>(fn: (state: FabricState) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      const state = await this.load();
      const value = await fn(state);
      prune(state, this.now());
      await this.save(state);
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<FabricState> {
    let raw: string;
    try {
      if ((await stat(this.file)).size > MAX_BYTES) throw Error("FABRIC_STATE_LIMIT");
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFabricState();
      throw error;
    }
    // Unreadable coordination state fails closed rather than silently resetting.
    try { return parseFabricState(JSON.parse(raw) as unknown); }
    catch { throw Error("FABRIC_STATE_CORRUPT"); }
  }
  private async save(state: FabricState): Promise<void> {
    const encoded = JSON.stringify(parseFabricState(state));
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw Error("FABRIC_STATE_LIMIT");
    await writeServerStateFile(this.file, encoded);
  }

  // Re-announcing with a known ID refreshes presence instead of forking identity.
  announce(input: AnnounceInput): Promise<string> {
    return this.serial(state => {
      const now = this.now();
      const runtimeId = input.runtimeId ?? "rt-" + randomUUID();
      const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
      const existing = state.runtimes.find(runtime => runtime.id === runtimeId);
      let name = existing?.name ?? agentName(runtimeId);
      for (let index = 1; state.runtimes.some(runtime => runtime.id !== runtimeId && runtime.name === name); index++) {
        if (index > 256) throw Error("FABRIC_NAME_LIMIT");
        name = agentName(runtimeId + ":" + index);
      }
      const next = RuntimeSchema.parse({
        id: runtimeId, label: input.label, source: input.source, node: input.node,
        name, model: input.model === undefined ? existing?.model ?? null : input.model,
        project: input.project === undefined ? existing?.project ?? null : input.project,
        phase: input.phase ?? existing?.phase ?? "working",
        capabilities: input.capabilities ?? [],
        taskId: existing?.taskId ?? null, activity: existing?.activity ?? null, stopped: false,
        registeredAt: existing?.registeredAt ?? now, lastSeenAt: now, leaseMs
      });
      if (existing) state.runtimes = state.runtimes.map(runtime => runtime.id === runtimeId ? next : runtime);
      else {
        if (state.runtimes.length >= MAX_RUNTIMES) throw Error("FABRIC_RUNTIME_LIMIT");
        state.runtimes.push(next);
      }
      return runtimeId;
    });
  }
  report(input: ReportInput): Promise<RuntimeHealth> {
    return this.serial(state => {
      const runtime = state.runtimes.find(candidate => candidate.id === input.runtimeId);
      if (!runtime) throw Error("FABRIC_RUNTIME_UNKNOWN");
      const now = this.now();
      const next = RuntimeSchema.parse({
        ...runtime, lastSeenAt: now,
        activity: input.activity === undefined ? runtime.activity : input.activity,
        taskId: input.taskId === undefined ? runtime.taskId : input.taskId,
        stopped: input.stopped ?? runtime.stopped
      });
      state.runtimes = state.runtimes.map(candidate => candidate.id === next.id ? next : candidate);
      return runtimeHealth(next, now);
    });
  }
  send(input: SendInput): Promise<string> {
    return this.serial(state => {
      const now = this.now();
      const messageId = input.messageId ?? "msg-" + randomUUID();
      const existing = state.messages.find(message => message.id === messageId);
      const next = MessageSchema.parse({
        id: messageId, taskId: input.taskId, from: input.from, to: input.to,
        kind: input.kind, body: input.body, createdAt: existing?.createdAt ?? now,
        expiresAt: (existing?.createdAt ?? now) + Math.min(input.ttlMs ?? MAX_MESSAGE_MS, MAX_MESSAGE_MS),
        ackedBy: existing?.ackedBy ?? []
      });
      if (existing) {
        // Replay must not rewrite history or resurrect an acknowledged message.
        if (JSON.stringify(existing) !== JSON.stringify(next)) throw Error("FABRIC_MESSAGE_ID_CONFLICT");
        return messageId;
      }
      if (state.messages.length >= MAX_MESSAGES) throw Error("FABRIC_MESSAGE_LIMIT");
      state.messages.push(next);
      return messageId;
    });
  }
  inbox(address: string, options: { includeAcked?: boolean } = {}): Promise<AgentMessage[]> {
    return this.serial(state => {
      const now = this.now();
      return state.messages.filter(message =>
        message.to === address && message.expiresAt > now &&
        (options.includeAcked || !message.ackedBy.includes(address)));
    });
  }
  ack(address: string, messageId: string): Promise<boolean> {
    return this.serial(state => {
      const message = state.messages.find(candidate => candidate.id === messageId);
      if (!message || message.to !== address) return false;
      if (!message.ackedBy.includes(address)) message.ackedBy.push(address);
      return true;
    });
  }
  snapshot(): Promise<FabricSnapshot> {
    return this.serial(state => {
      const now = this.now();
      return {
        generatedAt: now,
        runtimes: state.runtimes.map(runtime => ({
          ...runtime,
          health: runtimeHealth(runtime, now),
          idleMs: Math.max(0, now - runtime.lastSeenAt),
          unreadCount: state.messages.filter(message =>
            message.to === runtime.id && message.expiresAt > now && !message.ackedBy.includes(runtime.id)).length
        })),
        messages: state.messages.slice()
      };
    });
  }
  async runtime(runtimeId: string): Promise<AgentRuntime> {
    await this.queue;
    const runtime = (await this.load()).runtimes.find(item => item.id === runtimeId);
    if (!runtime || runtime.stopped) throw Error("FABRIC_RUNTIME_UNKNOWN");
    return runtime;
  }
  async resolveName(address: string): Promise<string> {
    // Preserve existing opaque/future runtime and role-mailbox addresses.
    if (/^(?:rt-[a-f0-9-]{36}|role:[A-Za-z0-9_.:-]+)$/i.test(address)) return address;
    await this.queue;
    const runtimes = (await this.load()).runtimes;
    if (runtimes.some(item => item.id === address)) return address;
    const matches = runtimes.filter(item => item.name === address && runtimeHealth(item, this.now()) === "active");
    if (matches.length !== 1) throw Error("FABRIC_RECIPIENT_UNKNOWN");
    return matches[0]!.id;
  }
}
