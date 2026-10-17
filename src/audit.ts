import { appendFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpActivityMonitor, type ActivityAgent } from "./mcp-activity.js";
import { describeCall } from "./audit-describe.js";
import { auditRecoveryKeyId, encryptAuditRecord, parseAuditRecoveryKey } from "./audit-crypto.js";
import { compactSanitize, normalizeAuditMode, redactSecretText, sanitizeMeta, traceSanitize, type AuditLevel, type AuditMode, type AuditSelection } from "./audit-sanitize.js";

export { sanitizeMeta, type AuditLevel, type AuditMode };

export interface AuditLoggerOptions {
  monitorDirectory?: string;
  mode?: AuditSelection;
  /** @deprecated Prefer mode. compact -> diagnostic, trace -> full. */
  level?: AuditSelection;
  filePath?: string;
  recoveryKey?: string | Buffer;
  /** @deprecated Prefer recoveryKey. */
  retentionKey?: string | Buffer;
  keyId?: string;
}

function legacyLevelForMode(mode: AuditMode): AuditLevel {
  if (mode === "off") return "off";
  if (mode === "full") return "trace";
  return "compact";
}

/** The audit file used when no explicit path is configured. */
export function resolveAuditLogPath(filePath?: string): string {
  return path.resolve(
    filePath ??
    process.env.LCMCP_AUDIT_LOG ??
    path.join(process.cwd(), ".local-commander-audit.jsonl")
  );
}

function fallbackWithoutPayload(record: Record<string, unknown>): Record<string, unknown> {
  const keep = ["ts", "event", "id", "tool", "durationMs", "ok", "errorClass"] as const;
  const fallback: Record<string, unknown> = {
    auditMode: "full",
    payloadRetained: false,
    retentionReason: "recovery_key_unavailable"
  };
  for (const key of keep) {
    if (key in record) fallback[key] = record[key];
  }
  return fallback;
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string): string => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text: string): string => paint(32, text);
const red = (text: string): string => paint(31, text);
const dim = (text: string): string => paint(2, text);

type AuditCall = { id: number; startedAt: number; label?: string; savedBytes?: number };
const SAVINGS_EVERY_CALLS = 5;

function savedSuffix(call: AuditCall): string {
  if (!call.savedBytes) return "";
  return green(` · ~${Math.round(call.savedBytes / 4).toLocaleString("en-US")} tokens saved`);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export class AuditLogger {
  readonly activity: McpActivityMonitor;
  private readonly agentContext = new AsyncLocalStorage<ActivityAgent>();
  withAgent<T>(agent: ActivityAgent, fn: () => T): T { return this.agentContext.run(agent, fn); }
  private seq = 0;
  private savedBytes = 0;
  private finishedCalls = 0;
  private readonly openCalls = new Map<number, AuditCall>();
  private readonly recoveryKey?: Buffer;
  private readonly keyId: string;
  private warnedMissingRetentionKey = false;

  readonly mode: AuditMode;
  /** @deprecated Compatibility view of mode. */
  readonly level: AuditLevel;
  readonly filePath: string;

  constructor(options: AuditLoggerOptions = {}) {
    this.activity = new McpActivityMonitor(options.monitorDirectory ?? path.join(process.cwd(), ".local-commander", "activity"));
    const selected =
      options.mode ??
      options.level ??
      process.env.LCMCP_AUDIT_MODE ??
      process.env.LCMCP_LOG_LEVEL ??
      "off";

    this.mode = normalizeAuditMode(selected);
    this.level = legacyLevelForMode(this.mode);
    this.filePath = resolveAuditLogPath(options.filePath);

    const configuredKey =
      options.recoveryKey ??
      options.retentionKey ??
      process.env.LCMCP_AUDIT_RECOVERY_KEY ??
      process.env.LCMCP_AUDIT_RETENTION_KEY;
    this.recoveryKey = configuredKey ? parseAuditRecoveryKey(configuredKey) : undefined;
    this.keyId =
      options.keyId ??
      process.env.LCMCP_AUDIT_KEY_ID?.trim() ??
      (this.recoveryKey ? auditRecoveryKeyId(this.recoveryKey) : "audit-v2");
  }

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private async persist(record: Record<string, unknown>, containsFullPayload = false): Promise<void> {
    if (this.mode === "off") return;

    let stored: Record<string, unknown>;
    if (this.recoveryKey) {
      stored = encryptAuditRecord(record, this.recoveryKey, this.keyId) as unknown as Record<string, unknown>;
    } else if (containsFullPayload) {
      stored = fallbackWithoutPayload(record);
      if (!this.warnedMissingRetentionKey) {
        this.warnedMissingRetentionKey = true;
        console.warn(
          "⚠ Full audit logging is on, but no recovery key is set (LCMCP_AUDIT_RECOVERY_KEY), so request details are not saved to the audit file."
        );
      }
    } else {
      stored = record;
    }

    try {
      await appendFile(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
    } catch (error) {
      console.error("⚠ Could not write the audit file:", error instanceof Error ? error.message : String(error));
    }
  }

  /** Adds stdout bytes that were really not sent to the model (e.g. a validated compact result). */
  recordSavedBytes(bytes: number, call?: AuditCall): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.savedBytes += bytes;
    if (call) call.savedBytes = (call.savedBytes ?? 0) + bytes;
  }

  /** recordSavedBytes for a tool body that only knows its request id; the call must still be open. */
  recordSavedBytesForRequest(requestId: number, bytes: number): void {
    this.recordSavedBytes(bytes, this.openCalls.get(requestId));
  }

  private countFinishedCall(): void {
    this.finishedCalls += 1;
    if (this.mode === "off" || this.finishedCalls % SAVINGS_EVERY_CALLS !== 0 || this.savedBytes <= 0) return;
    const tokens = Math.round(this.savedBytes / 4).toLocaleString("en-US");
    console.log(green(`💰 ~${tokens} tokens saved so far in this session (${this.finishedCalls} requests)`));
  }

  async start(tool: string, meta: Record<string, unknown>): Promise<AuditCall> {
    const id = this.nextId();
    const startedAt = Date.now();
    const now = new Date(startedAt);
    const time = now.toLocaleTimeString("en-GB", { hour12: false });

    const diagnostic = this.mode === "off" || this.mode === "minimal"
      ? {}
      : compactSanitize(meta);

    let label = tool.replaceAll("_", " ");
    if (this.mode === "diagnostic" || this.mode === "full") {
      const described = describeCall(tool, meta, redactSecretText);
      label = described.text;
      if (described.announceStart) console.log(dim(`${time} ▶ ${label}`));
    }

    const record: Record<string, unknown> = {
      ts: now.toISOString(),
      event: "start",
      id,
      tool
    };

    if (this.mode === "diagnostic") {
      record.request = diagnostic;
    } else if (this.mode === "full") {
      record.request = sanitizeMeta(meta, "full");
    }

    await this.persist(record, this.mode === "full");
    const call: AuditCall = { id, startedAt, label };
    this.openCalls.set(id, call);
    this.activity.start(id, tool, meta, this.agentContext.getStore() ?? null);
    return call;
  }

  async finish(tool: string, call: AuditCall, result?: unknown, responseBytes?: number): Promise<void> {
    this.activity.finish(call.id, result, call.savedBytes ?? 0, undefined, responseBytes);
    this.openCalls.delete(call.id);
    const durationMs = Date.now() - call.startedAt;
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour12: false });

    if (this.mode !== "off") {
      console.log(`${time} ✓ ${call.label ?? tool} · ${formatSeconds(durationMs)}${savedSuffix(call)}`);
    }

    const record: Record<string, unknown> = {
      ts: now.toISOString(),
      event: "finish",
      id: call.id,
      tool,
      durationMs,
      ok: true
    };

    if (this.mode === "diagnostic" && result && typeof result === "object") {
      record.response = compactSanitize(result as Record<string, unknown>);
    } else if (this.mode === "full") {
      record.response =
        result && typeof result === "object"
          ? sanitizeMeta(result as Record<string, unknown>, "full")
          : traceSanitize(result);
    }

    await this.persist(record, this.mode === "full");
    this.countFinishedCall();
  }

  async fail(tool: string, call: AuditCall, error: unknown): Promise<void> {
    this.activity.finish(call.id, undefined, call.savedBytes ?? 0, error);
    this.openCalls.delete(call.id);
    const durationMs = Date.now() - call.startedAt;
    const message = redactSecretText(error instanceof Error ? error.message : String(error));
    const errorClass = error instanceof Error && error.name ? error.name : "Error";
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour12: false });

    if (this.mode !== "off") {
      console.error(red(`${time} ✗ ${call.label ?? tool} · ${formatSeconds(durationMs)} · failed: ${message.replace(/\s+/g, " ").slice(0, 160) || errorClass}`));
    }

    const record: Record<string, unknown> = {
      ts: now.toISOString(),
      event: "finish",
      id: call.id,
      tool,
      durationMs,
      ok: false,
      errorClass
    };
    if (this.mode === "full") {
      record.error = message;
    }

    await this.persist(record, this.mode === "full");
    this.countFinishedCall();
  }
}
