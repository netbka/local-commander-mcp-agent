import assert from "node:assert/strict";
import test from "node:test";
import { readRpcResponse, McpWireError, rpcEnvelope, rpcHeaders } from "./helpers/mcp-wire.js";

const response = (id: string | number = 7) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "fixture" }] } });
function wire(text: string, media = "application/json", size = 5): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    const end = Math.min(bytes.length, offset + size);
    c.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { "content-type": media } });
}
async function fails(input: Response, code: string, options = {}) {
  await assert.rejects(readRpcResponse(input, 7, options), (e: unknown) => e instanceof McpWireError && e.code === code);
}

test("wire reader accepts bounded JSON and preserves ID type", async () => {
  assert.equal((await readRpcResponse(wire(JSON.stringify(response())), 7)).id, 7);
  await fails(wire(JSON.stringify(response("7"))), "RPC_ID_MISMATCH_OR_TRUNCATED");
});

test("SSE reader handles chunked UTF8, CRLF, multiline data and preceding notifications", async () => {
  const event = { jsonrpc: "2.0", id: 7, result: { text: "Привет, שלום" } };
  const before = 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\n\r\n';
  const multi = 'data: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{"text":"Привет, שלום"}}\r\n\r\n';
  assert.deepEqual(await readRpcResponse(wire(": heartbeat\r\n\r\n" + before + multi, "text/event-stream", 1), 7), event);
});

test("legacy SSE priming event with empty data is not a JSON parse failure", async () => {
  const data = 'id: resume-cursor\ndata:\n\ndata: ' + JSON.stringify(response()) + '\n\n';
  assert.equal((await readRpcResponse(wire(data, "text/event-stream", 1), 7)).id, 7);
});

test("SSE reader selects matching response after an unrelated ID", async () => {
  const data = 'data: ' + JSON.stringify(response(19)) + '\n\ndata: ' + JSON.stringify(response()) + '\n\n';
  assert.equal((await readRpcResponse(wire(data, "text/event-stream"), 7)).id, 7);
});

test("SSE reader accepts CR line endings and comments without buffering history", async () => {
  const data = ': heartbeat\r\rid: ignored\revent: message\rdata: ' + JSON.stringify(response()) + '\r\r';
  assert.equal((await readRpcResponse(wire(data, "text/event-stream", 1), 7)).id, 7);
});

test("reader returns matching result without waiting for an open stream to close", async () => {
  let cancelled = false;
  const data = new TextEncoder().encode('data: ' + JSON.stringify(response()) + '\n\n');
  const res = new Response(new ReadableStream({ start(c) { c.enqueue(data); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  assert.equal((await readRpcResponse(res, 7, { timeoutMs: 100 })).id, 7);
  assert.equal(cancelled, true);
});

test("unterminated SSE message is not a valid final response", async () => {
  await fails(wire('data: ' + JSON.stringify(response()), 'text/event-stream'), "RPC_ID_MISMATCH_OR_TRUNCATED");
});

test("message and byte ceilings apply before retaining unbounded output", async () => {
  await fails(wire(JSON.stringify(response())), "RESPONSE_TOO_LARGE", { maxBytes: 8 });
  const notification = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
  await fails(wire(notification.repeat(4), 'text/event-stream'), "TOO_MANY_MESSAGES", { maxMessages: 2 });
  await fails(new Response('{}', { headers: { "content-type": "application/json", "content-length": "99999999" } }), "RESPONSE_TOO_LARGE");
});

test("malformed payloads fail with safe codes, not copied response bodies", async () => {
  for (const data of ['[{}]', '{}', '{"jsonrpc":"2.0","id":7}', '{"jsonrpc":"2.0","id":7,"result":{},"error":{}}']) {
    await fails(wire(data), "INVALID_RPC_RESPONSE");
  }
  await fails(wire('SYNTHETIC_PRIVATE_TEXT'), "INVALID_JSON");
  await fails(wire('{}', 'text/html'), "UNSUPPORTED_CONTENT_TYPE");
  await fails(new Response(null, { headers: { 'content-type': 'application/json' } }), "EMPTY_RPC_BODY");
  await fails(new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }), "INVALID_UTF8");
});

test("timeout and AbortSignal cancel a stalled response", async () => {
  const stalled = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "text/event-stream" } });
  await fails(stalled(), "READ_TIMEOUT", { timeoutMs: 20 });
  const abort = new AbortController(); abort.abort();
  await fails(stalled(), "READ_ABORTED", { signal: abort.signal });
});

test("JSON RPC errors preserve the requested ID and are not mistaken for results", async () => {
  const error = { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Unknown method" } };
  assert.deepEqual(await readRpcResponse(wire(JSON.stringify(error)), 7), error);
});

test("modern headers and envelope are explicit without changing legacy params", () => {
  assert.deepEqual(rpcEnvelope(1, "tools/list").params, {});
  assert.equal(rpcHeaders("tools/list")["mcp-method"], undefined);
  const params = rpcEnvelope(1, "tools/call", { name: "fs_read" }, true).params;
  assert.equal((params._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.equal(rpcHeaders("tools/call", "fs_read", true)["mcp-name"], "fs_read");
});
