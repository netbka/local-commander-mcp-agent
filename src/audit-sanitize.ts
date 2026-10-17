import { looksSensitive } from "./guard.js";

// Audit sanitization shared by the personal runtime audit log and the managed agent content audit.
// Kept free of runtime/monitor imports so the agent bundle can reuse it.

export type AuditMode = "off" | "minimal" | "diagnostic" | "full";
/** @deprecated Legacy aliases are retained for compatibility with existing local setups. */
export type AuditLevel = "off" | "compact" | "trace";
export type AuditSelection = AuditMode | AuditLevel;

export type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish };

const SECRET_FIELD = /^(authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|client_secret|password|passwd|api[_-]?key|audit[_-]?recovery[_-]?key|recovery[_-]?key|audit[_-]?retention[_-]?key|retention[_-]?key|encryption[_-]?key|secret)$/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const COMPACT_PAYLOAD_FIELD = /^(body|content|oldText|newText|headers|args|stdout|stderr)$/i;

export function normalizeAuditMode(value: unknown): AuditMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "off":
      return "off";
    case "minimal":
      return "minimal";
    case "compact":
    case "diagnostic":
      return "diagnostic";
    case "trace":
    case "full":
      return "full";
    case "":
      return "off";
    default:
      throw new Error(`Unsupported audit mode: ${String(value)}`);
  }
}

export function isSensitivePath(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === "credentials.json" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    looksSensitive(value)
  );
}

export function redactSecretText(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(
      /((?:access_token|refresh_token|id_token|client_secret|password|passwd|api[_-]?key|audit[_-]?recovery[_-]?key|recovery[_-]?key|audit[_-]?retention[_-]?key|retention[_-]?key|encryption[_-]?key|secret|authorization|cookie)\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1<redacted>"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<redacted-openai-key>")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      "<redacted-private-key>"
    );
}

export function traceSanitize(
  value: unknown,
  context: { key?: string; sensitivePath?: boolean } = {}
): Jsonish {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    if (context.key && SECRET_FIELD.test(context.key)) return "<redacted>";
    if (context.sensitivePath && /^(body|content|oldText|newText|stdout|stderr)$/i.test(context.key ?? "")) {
      return `<redacted sensitive-file payload ${Buffer.byteLength(value)} bytes>`;
    }
    return redactSecretText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => traceSanitize(item, context));
  }

  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const sensitivePath =
      context.sensitivePath ||
      isSensitivePath(object.path) ||
      isSensitivePath(object.file) ||
      isSensitivePath(object.cwd);

    const out: Record<string, Jsonish> = {};
    for (const [key, child] of Object.entries(object)) {
      if (SECRET_FIELD.test(key)) {
        out[key] = "<redacted>";
        continue;
      }

      if (key.toLowerCase() === "headers" && child && typeof child === "object" && !Array.isArray(child)) {
        const headers: Record<string, Jsonish> = {};
        for (const [header, headerValue] of Object.entries(child as Record<string, unknown>)) {
          headers[header] = SECRET_HEADER.test(header)
            ? "<redacted>"
            : traceSanitize(headerValue, { key: header, sensitivePath });
        }
        out[key] = headers;
        continue;
      }

      out[key] = traceSanitize(child, { key, sensitivePath });
    }
    return out;
  }

  return redactSecretText(String(value));
}

export function compactSanitize(input: Record<string, unknown>): Record<string, Jsonish> {
  const sensitivePath =
    isSensitivePath(input.path) ||
    isSensitivePath(input.file) ||
    isSensitivePath(input.cwd);

  const out: Record<string, Jsonish> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = "<redacted>";
      continue;
    }
    if (COMPACT_PAYLOAD_FIELD.test(key)) {
      out[key] =
        typeof value === "string"
          ? `<redacted ${Buffer.byteLength(value)} bytes>`
          : Array.isArray(value)
            ? `<redacted ${value.length} items>`
            : "<redacted>";
      continue;
    }
    if (typeof value === "string") {
      out[key] = sensitivePath && /^(stdout|stderr)$/i.test(key)
        ? "<redacted sensitive-file payload>"
        : redactSecretText(value.length > 500 ? `${value.slice(0, 500)}…` : value);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 40).map((item) =>
        traceSanitize(item, { key, sensitivePath })
      );
      continue;
    }
    out[key] = traceSanitize(value, { key, sensitivePath });
  }
  return out;
}

export function sanitizeMeta(
  input: Record<string, unknown> = {},
  level: AuditSelection = "diagnostic"
): Record<string, Jsonish> {
  const mode = normalizeAuditMode(level);
  if (mode === "off" || mode === "minimal") return {};
  return mode === "full"
    ? (traceSanitize(input) as Record<string, Jsonish>)
    : compactSanitize(input);
}
