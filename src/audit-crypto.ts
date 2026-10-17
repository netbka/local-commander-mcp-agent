import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gunzipSync, gzip, gzipSync } from "node:zlib";

const gzipAsync = promisify(gzip);

export const AUDIT_ENCRYPTION_ALGORITHM = "A256GCM" as const;
export const AUDIT_COMPRESSION = "gzip" as const;
export const AUDIT_RECOVERY_KEY_PREFIX = "lca1_" as const;
const AUDIT_ENVELOPE_VERSION = 2 as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface AuditEncryptedEnvelope {
  v: typeof AUDIT_ENVELOPE_VERSION;
  encrypted: true;
  alg: typeof AUDIT_ENCRYPTION_ALGORITHM;
  compression: typeof AUDIT_COMPRESSION;
  kid: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function generateAuditRecoveryKey(): string {
  return `${AUDIT_RECOVERY_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

function decodeConfiguredKey(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Audit recovery key is empty");
  }

  if (trimmed.startsWith(AUDIT_RECOVERY_KEY_PREFIX)) {
    return Buffer.from(trimmed.slice(AUDIT_RECOVERY_KEY_PREFIX.length), "base64url");
  }

  const encoded = trimmed.startsWith("base64:") ? trimmed.slice("base64:".length) : trimmed;
  return Buffer.from(encoded, "base64");
}

export function parseAuditRecoveryKey(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : decodeConfiguredKey(value);
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    throw new Error("Audit recovery key must decode to exactly 32 bytes");
  }
  return key;
}

/** @deprecated Compatibility alias for the earlier retention-key name. */
export const parseAuditRetentionKey = parseAuditRecoveryKey;

export function auditRecoveryKeyId(value: string | Buffer): string {
  const key = parseAuditRecoveryKey(value);
  try {
    const digest = createHash("sha256").update(key).digest();
    return `rk_${digest.subarray(0, 12).toString("base64url")}`;
  } finally {
    key.fill(0);
  }
}

function additionalData(kid: string): Buffer {
  return Buffer.from(
    `local-commander:audit:v${AUDIT_ENVELOPE_VERSION}:compression:${AUDIT_COMPRESSION}:kid:${kid}`,
    "utf8"
  );
}

export function encryptAuditRecord(
  record: Record<string, unknown>,
  keyInput: string | Buffer,
  keyId?: string
): AuditEncryptedEnvelope {
  const compressed = gzipSync(Buffer.from(JSON.stringify(record), "utf8"), { level: 9 });
  return sealCompressed(compressed, keyInput, keyId);
}

/** Same envelope as encryptAuditRecord; compression runs on the libuv pool instead of the event loop. */
export async function encryptAuditRecordAsync(
  record: Record<string, unknown>,
  keyInput: string | Buffer,
  keyId?: string
): Promise<AuditEncryptedEnvelope> {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(record), "utf8"), { level: 9 });
  return sealCompressed(compressed, keyInput, keyId);
}

function sealCompressed(compressed: Buffer, keyInput: string | Buffer, keyId?: string): AuditEncryptedEnvelope {
  const key = parseAuditRecoveryKey(keyInput);
  const kid = keyId?.trim() || auditRecoveryKeyId(key);
  const iv = randomBytes(IV_BYTES);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(kid));

    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: AUDIT_ENVELOPE_VERSION,
      encrypted: true,
      alg: AUDIT_ENCRYPTION_ALGORITHM,
      compression: AUDIT_COMPRESSION,
      kid,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  } finally {
    key.fill(0);
  }
}

export function decryptAuditRecord(
  envelope: AuditEncryptedEnvelope,
  keyInput: string | Buffer
): Record<string, unknown> {
  if (
    envelope.v !== AUDIT_ENVELOPE_VERSION ||
    envelope.encrypted !== true ||
    envelope.alg !== AUDIT_ENCRYPTION_ALGORITHM ||
    envelope.compression !== AUDIT_COMPRESSION ||
    !envelope.kid
  ) {
    throw new Error("Unsupported audit encryption envelope");
  }

  const key = parseAuditRecoveryKey(keyInput);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    key.fill(0);
    throw new Error("Invalid audit encryption envelope");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(envelope.kid));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plaintext = gunzipSync(compressed).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Audit record payload must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    key.fill(0);
  }
}
