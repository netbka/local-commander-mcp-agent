import { createReadStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolveAuditLogPath } from "./audit.js";

/** Encrypted envelopes carry no plaintext timestamp, so they cannot be attributed to a day without the key. */
export const UNDATED_DAY = "undated";
const MAX_KEY_IDS = 16;
const SIZE_SAMPLE = 100_000;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

type RecordKind = "encrypted" | "payloadSuppressed" | "plaintextDetail" | "metadataOnly";

export interface AuditDayStats {
  /** UTC date (YYYY-MM-DD), or "undated" for encrypted envelopes. */
  day: string;
  records: number;
  bytes: number;
  starts: number;
  finishes: number;
  failed: number;
  encrypted: number;
  payloadSuppressed: number;
  plaintextDetail: number;
  metadataOnly: number;
}

export interface AuditLogStats {
  filePath: string;
  exists: boolean;
  fileBytes: number;
  modifiedAt: string | null;
  records: number;
  malformedLines: number;
  /** AES-256-GCM envelopes written with a user-held recovery key. */
  encrypted: number;
  /** Full mode without a key: only metadata was kept. */
  payloadSuppressed: number;
  /** Plaintext request/response/error detail (diagnostic mode, or records written before encryption existed). */
  plaintextDetail: number;
  /** Plaintext ts/event/id/tool/duration/status only. */
  metadataOnly: number;
  /** Non-secret recovery-key fingerprints seen in envelopes. */
  keyIds: string[];
  oldest: string | null;
  newest: string | null;
  recordBytes: { p50: number; p95: number; max: number; sampled: boolean };
  days: AuditDayStats[];
  disk: { freeBytes: number; totalBytes: number } | null;
}

function classify(record: Record<string, unknown>): RecordKind {
  if (record.encrypted === true && typeof record.ciphertext === "string") return "encrypted";
  if (record.payloadRetained === false) return "payloadSuppressed";
  if ("request" in record || "response" in record || "error" in record) return "plaintextDetail";
  return "metadataOnly";
}

function timestampOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.ts !== "string") return undefined;
  const time = Date.parse(record.ts);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

async function diskSpace(directory: string): Promise<AuditLogStats["disk"]> {
  try {
    const info = await statfs(directory);
    return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {
    return null;
  }
}

/**
 * Read-only statistics for the native audit JSONL. Each line is parsed only to classify it:
 * request/response/error values, ciphertext and key material are never returned or kept.
 */
export async function summarizeAuditLog(filePath: string): Promise<AuditLogStats> {
  const resolved = path.resolve(filePath);
  const stats: AuditLogStats = {
    filePath: resolved, exists: false, fileBytes: 0, modifiedAt: null, records: 0, malformedLines: 0,
    encrypted: 0, payloadSuppressed: 0, plaintextDetail: 0, metadataOnly: 0, keyIds: [],
    oldest: null, newest: null, recordBytes: { p50: 0, p95: 0, max: 0, sampled: false }, days: [],
    disk: await diskSpace(path.dirname(resolved))
  };

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return stats;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Not a file: ${resolved}`);
  stats.exists = true;
  stats.fileBytes = info.size;
  stats.modifiedAt = info.mtime.toISOString();

  const days = new Map<string, AuditDayStats>();
  const keyIds = new Set<string>();
  const sizes: number[] = [];
  let seen = 0;
  const lines = createInterface({ input: createReadStream(resolved, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const bytes = Buffer.byteLength(line) + 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      record = undefined;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      stats.malformedLines += 1;
      continue;
    }

    const fields = record as Record<string, unknown>;
    const kind = classify(fields);
    const timestamp = kind === "encrypted" ? undefined : timestampOf(fields);
    const day = timestamp?.slice(0, 10) ?? UNDATED_DAY;
    let bucket = days.get(day);
    if (!bucket) {
      bucket = { day, records: 0, bytes: 0, starts: 0, finishes: 0, failed: 0, encrypted: 0, payloadSuppressed: 0, plaintextDetail: 0, metadataOnly: 0 };
      days.set(day, bucket);
    }
    bucket.records += 1;
    bucket.bytes += bytes;
    bucket[kind] += 1;
    if (fields.event === "start") bucket.starts += 1;
    if (fields.event === "finish") bucket.finishes += 1;
    if (fields.ok === false) bucket.failed += 1;
    stats.records += 1;
    stats[kind] += 1;
    if (kind === "encrypted" && typeof fields.kid === "string" && KEY_ID.test(fields.kid) && keyIds.size < MAX_KEY_IDS) keyIds.add(fields.kid);
    if (timestamp) {
      if (!stats.oldest || timestamp < stats.oldest) stats.oldest = timestamp;
      if (!stats.newest || timestamp > stats.newest) stats.newest = timestamp;
    }

    // Reservoir sample keeps percentile memory bounded on very large files.
    seen += 1;
    stats.recordBytes.max = Math.max(stats.recordBytes.max, bytes);
    if (sizes.length < SIZE_SAMPLE) sizes.push(bytes);
    else {
      const slot = Math.floor(Math.random() * seen);
      if (slot < SIZE_SAMPLE) sizes[slot] = bytes;
    }
  }

  sizes.sort((a, b) => a - b);
  stats.recordBytes.p50 = percentile(sizes, 0.5);
  stats.recordBytes.p95 = percentile(sizes, 0.95);
  stats.recordBytes.sampled = seen > SIZE_SAMPLE;
  stats.keyIds = [...keyIds].sort();
  stats.days = [...days.values()].sort((a, b) =>
    a.day === UNDATED_DAY ? 1 : b.day === UNDATED_DAY ? -1 : a.day.localeCompare(b.day)
  );
  return stats;
}

// Usage: node dist/audit-stats.js [audit-file]  (defaults to LCMCP_AUDIT_LOG or ./.local-commander-audit.jsonl)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  summarizeAuditLog(resolveAuditLogPath(process.argv[2])).then(
    (stats) => process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`),
    (error: unknown) => {
      console.error("Could not read the audit file:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
