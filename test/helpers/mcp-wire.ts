// Raw-wire verifier for negative protocol tests. Not a replacement MCP client.
// Deliberately retains only the requested response, never unbounded transcripts.
export class McpWireError extends Error {
  constructor(readonly code: string) { super(code); this.name = "McpWireError"; }
}
export type RpcId = string | number;
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}
export interface WireOptions {
  maxBytes?: number;
  maxMessages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decodeMessage(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new McpWireError("INVALID_JSON"); }
  if (!object(value) || value.jsonrpc !== "2.0") throw new McpWireError("INVALID_RPC_RESPONSE");
  return value;
}
function responseFor(value: Record<string, unknown>, expectedId: RpcId): RpcResponse | null {
  // Server notifications are permitted before the final SSE response.
  if (!("id" in value) && typeof value.method === "string" && !("result" in value) && !("error" in value)) return null;
  if ((typeof value.id !== "string" && !Number.isSafeInteger(value.id) && value.id !== null) ||
      ("result" in value) === ("error" in value) || "method" in value) throw new McpWireError("INVALID_RPC_RESPONSE");
  if ("result" in value && !object(value.result)) throw new McpWireError("INVALID_RPC_RESPONSE");
  if ("error" in value && (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string")) {
    throw new McpWireError("INVALID_RPC_RESPONSE");
  }
  if (value.id !== expectedId) return null;
  return value as unknown as RpcResponse;
}

export async function readRpcResponse(response: Response, expectedId: RpcId, options: WireOptions = {}): Promise<RpcResponse> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxMessages = options.maxMessages ?? 64;
  const timeoutMs = options.timeoutMs ?? 5000;
  if ((typeof expectedId !== "string" && !Number.isSafeInteger(expectedId)) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new McpWireError("INVALID_WIRE_OPTIONS");
  }
  const media = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json" && media !== "text/event-stream") throw new McpWireError("UNSUPPORTED_CONTENT_TYPE");
  if (!response.body) throw new McpWireError("EMPTY_RPC_BODY");
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body.cancel().catch(() => {});
    throw new McpWireError("RESPONSE_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let lines = "";
  let eventData: string[] = [];
  let messages = 0;
  let found: RpcResponse | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new McpWireError("READ_TIMEOUT")), timeoutMs);
    onAbort = () => reject(new McpWireError("READ_ABORTED"));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
  function consumeLine(line: string): void {
    if (!line) {
      if (!eventData.length) return;
      const data = eventData.join("\n");
      eventData = [];
      // Legacy HTTP may prime resumable streams with an event id and empty data.
      if (!data) return;
      if (++messages > maxMessages) throw new McpWireError("TOO_MANY_MESSAGES");
      const value = decodeMessage(data);
      const match = responseFor(value, expectedId);
      if (match && found) throw new McpWireError("DUPLICATE_RPC_RESPONSE");
      if (match) found = match;
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") eventData.push(value);
    }
  }
  function consumeLines(final: boolean): void {
    const newline = /\r\n|\r|\n/g;
    let last = 0;
    for (let match = newline.exec(lines); match; match = newline.exec(lines)) {
      if (!final && match[0] === "\r" && match.index === lines.length - 1) break;
      consumeLine(lines.slice(last, match.index));
      last = match.index + match[0].length;
    }
    lines = lines.slice(last);
  }
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) {
        let tail: string;
        try { tail = decoder.decode(); } catch { throw new McpWireError("INVALID_UTF8"); }
        if (media === "application/json") text += tail;
        else { lines += tail; consumeLines(true); }
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new McpWireError("RESPONSE_TOO_LARGE");
      let decoded: string;
      try { decoded = decoder.decode(chunk.value, { stream: true }); }
      catch { throw new McpWireError("INVALID_UTF8"); }
      if (media === "application/json") text += decoded;
      else {
        lines += decoded;
        consumeLines(false);
        // A subscription stream need not close. The matching terminal response is
        // sufficient; cancel our reader so there is no orphaned connection.
        if (found) return found;
      }
    }
    if (media === "application/json") {
      const value = decodeMessage(text);
      found = responseFor(value, expectedId);
    }
    if (!found) throw new McpWireError("RPC_ID_MISMATCH_OR_TRUNCATED");
    return found;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    // Cancel best-effort; a hostile stream's cancellation cannot hold cleanup open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const MODERN_REVISION = "2026-07-28";
export const LEGACY_REVISION = "2025-11-25";
export function rpcEnvelope(id: RpcId, method: string, params: Record<string, unknown> = {}, modern = false) {
  return { jsonrpc: "2.0", id, method, params: modern ? {
    ...params,
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
      "io.modelcontextprotocol/clientInfo": { name: "lc63-conformance", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {} }
  } : params };
}
export function rpcHeaders(method: string, name?: string, modern = false): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": modern ? MODERN_REVISION : LEGACY_REVISION,
    ...(modern ? { "mcp-method": method, ...(name ? { "mcp-name": name } : {}) } : {}) };
}
