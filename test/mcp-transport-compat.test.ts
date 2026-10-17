import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildChildEnvironment } from "../src/child-environment.js";
import { LEGACY_REVISION, MODERN_REVISION, readRpcResponse, rpcEnvelope, rpcHeaders, type RpcResponse } from "./helpers/mcp-wire.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function allocatePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function result(rpc: RpcResponse): Record<string, unknown> {
  assert.equal(rpc.error, undefined, "MCP request must produce a result");
  assert.ok(rpc.result);
  return rpc.result;
}
function content(rpc: RpcResponse): Record<string, unknown> {
  const value = result(rpc);
  assert.notEqual(value.isError, true, "fixture read succeeds");
  const blocks = value.content as Array<{ type: string; text?: string }>;
  const text = blocks?.find((c) => c.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text!);
}

// This fixture uses the actual native entrypoint and configured root/auth guards.
// No existing server, .env, customer project, database or provider is used.
test("LC-63 real native HTTP legacy/modern compatibility and launch safety", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-http-conformance-"));
  const root = path.join(dir, "approved workspace");
  await mkdir(root);
  const readme = path.join(root, "README.txt");
  await writeFile(readme, "Hello from the owned fixture. Привет. שלום.");
  const outside = path.join(dir, "outside.txt");
  await writeFile(outside, "SYNTHETIC_OUTSIDE_ROOT");
  await writeFile(path.join(root, ".env"), "SYNTHETIC_SECRET_FILE=not-a-real-key");
  const cfg = path.join(dir, "settings.json");
  const audit = path.join(dir, "audit.jsonl");
  const token = randomBytes(32).toString("base64url");
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  await writeFile(cfg, JSON.stringify({ roots: [root], server: { host: "127.0.0.1", port },
    auth: { mode: "bearer", token, publicBaseUrl: "https://public.example.test", allowedOrigins: ["https://chat.example.test"], oauthStatePath: path.join(dir, "oauth.json") },
    shell: { allowedCommands: ["node"], maxTimeoutMs: 3000 } }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...buildChildEnvironment(process.env), DOTENV_CONFIG_PATH: path.join(dir, "not-present.env"),
      LCMCP_CONFIG: cfg, LCMCP_LOG_LEVEL: "off", LCMCP_AUDIT_LOG: audit }
  });
  // Drain both pipes without returning their potentially sensitive content.
  child.stdout.resume(); child.stderr.resume();
  const closed = once(child, "close");
  let id = 0;
  async function post(method: string, params: Record<string, unknown> = {}, modern = false,
    extras: Record<string, string> = {}, credential: string | null = token) {
    const requestId = ++id;
    const headers = { ...rpcHeaders(method, typeof params.name === "string" ? params.name : undefined, modern),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...extras };
    const response = await fetch(base + "/mcp", { method: "POST", headers,
      body: JSON.stringify(rpcEnvelope(requestId, method, params, modern)), redirect: "error", signal: AbortSignal.timeout(5000) });
    return { response, requestId };
  }
  async function rpc(method: string, params: Record<string, unknown> = {}, modern = false) {
    const { response, requestId } = await post(method, params, modern);
    assert.equal(response.status, 200, method);
    return readRpcResponse(response, requestId);
  }
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error("ISOLATED_NATIVE_SERVER_EXITED");
      try { ready = (await fetch(base + "/health", { signal: AbortSignal.timeout(200) })).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(ready, "owned native server becomes ready");

    await t.test("unauthenticated modern discovery is 401, not legacy fallback", async () => {
      const { response } = await post("server/discover", {}, true, {}, null);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
      await response.body?.cancel();
    });
    await t.test("spoofed client identity never replaces authentication", async () => {
      const { response } = await post("tools/list", {}, true, {}, "synthetic-wrong-token");
      assert.equal(response.status, 401); await response.body?.cancel();
    });
    await t.test("legacy initialize returns declared version and instructions", async () => {
      const data = result(await rpc("initialize", { protocolVersion: LEGACY_REVISION, capabilities: {}, clientInfo: { name: "lc63-legacy", version: "1.0" } }));
      assert.equal(data.protocolVersion, LEGACY_REVISION);
      assert.equal((data.serverInfo as { name: string }).name, "local-commander-mcp");
      assert.match(String(data.instructions), /AGENTS\.md/);
    });
    await t.test("legacy initialized notification is accepted without a response body", async () => {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders("notifications/initialized"), authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 202); assert.equal(await response.text(), "");
    });
    await t.test("modern discovery is stateless and returns versioned server identity", async () => {
      const { response, requestId } = await post("server/discover", {}, true);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("mcp-session-id"), null);
      const data = result(await readRpcResponse(response, requestId));
      assert.equal(data.resultType, "complete");
      assert.ok((data.supportedVersions as string[]).includes(MODERN_REVISION));
      assert.equal(((data._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"] as { name: string }).name, "local-commander-mcp");
    });
    await t.test("both revisions expose the same tools and input schemas", async () => {
      const legacy = result(await rpc("tools/list")).tools as Array<{ name: string; inputSchema: unknown }>;
      const modern = result(await rpc("tools/list", {}, true)).tools as Array<{ name: string; inputSchema: unknown }>;
      const normalize = (tools: typeof legacy) => tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(normalize(modern), normalize(legacy));
      assert.ok(legacy.some((tool) => tool.name === "parallel_command_run"));
      assert.ok(legacy.some((tool) => tool.name === "fs_read"));
    });
    for (const modern of [false, true]) {
      const revision = modern ? MODERN_REVISION : LEGACY_REVISION;
      await t.test(`${revision} reads only the approved UTF-8 fixture`, async () => {
        const data = content(await rpc("tools/call", { name: "fs_read", arguments: { path: readme } }, modern));
        assert.equal(data.content, "Hello from the owned fixture. Привет. שלום.");
      });
      await t.test(`${revision} independent replies retain their request IDs`, async () => {
        const replies = await Promise.all(Array.from({ length: 4 }, () => rpc("tools/call", { name: "fs_read", arguments: { path: readme } }, modern)));
        assert.equal(new Set(replies.map((r) => r.id)).size, 4);
        for (const reply of replies) assert.equal(content(reply).content, "Hello from the owned fixture. Привет. שלום.");
      });
      await t.test(`${revision} unknown tools fail without executing anything`, async () => {
        const reply = await rpc("tools/call", { name: "lc63_nonexistent_tool", arguments: {} }, modern);
        assert.ok(reply.error || reply.result?.isError === true);
      });
      await t.test(`${revision} root escape and protected file reads are rejected`, async () => {
        for (const file of [outside, path.join(root, ".env")]) {
          const reply = await rpc("tools/call", { name: "fs_read", arguments: { path: file } }, modern);
          assert.equal(result(reply).isError, true);
          assert.ok(!JSON.stringify(reply).includes("SYNTHETIC_OUTSIDE_ROOT"));
          assert.ok(!JSON.stringify(reply).includes("not-a-real-key"));
        }
      });
    }
    await t.test("configured public origin preserves the tunnel-facing flow", async () => {
      const { response, requestId } = await post("server/discover", {}, true, { origin: "https://public.example.test" });
      assert.equal(response.status, 200);
      assert.equal(result(await readRpcResponse(response, requestId)).resultType, "complete");
    });
    await t.test("configured extra origin is accepted for Origin but never as Host", async () => {
      const { response, requestId } = await post("server/discover", {}, true, { origin: "https://chat.example.test" });
      assert.equal(response.status, 200);
      assert.equal(result(await readRpcResponse(response, requestId)).resultType, "complete");
    });
    for (const origin of ["https://untrusted.example", "null", "not-an-origin", "http://127.0.0.1:1"]) {
      await t.test(`untrusted origin is denied before authenticated tool dispatch: ${origin}`, async () => {
        const { response } = await post("tools/call", { name: "fs_read", arguments: { path: readme } }, true, { origin });
        assert.equal(response.status, 403);
        const body = await response.json() as { error: { message: string } };
        assert.equal(body.error.message, "ORIGIN_NOT_ALLOWED");
      });
    }
    await t.test("host spoofing cannot be repaired with forwarded headers", async () => {
      // Use node:http so the test sends the chosen Host verbatim rather than a
      // fetch implementation deriving it from the destination URL.
      const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false,
          headers: { ...rpcHeaders("server/discover", undefined, true), authorization: `Bearer ${token}`,
            host: "untrusted.example", "x-forwarded-host": "public.example.test" }
        }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => body += chunk);
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        request.setTimeout(2000, () => request.destroy(new Error("HOST_TEST_TIMEOUT")));
        request.on("error", reject);
        request.end(JSON.stringify(rpcEnvelope(++id, "server/discover", {}, true)));
      });
      assert.equal(reply.status, 403);
      assert.equal((JSON.parse(reply.body) as { error: { message: string } }).error.message, "HOST_NOT_ALLOWED");
    });
    for (const [header, value] of [["mcp-method", "tools/list"], ["mcp-name", "process_kill"]]) {
      await t.test(`${header} mismatch is a protocol error, not a different dispatched tool`, async () => {
        const { response } = await post("tools/call", { name: "fs_read", arguments: { path: readme } }, true, { [header!]: value! });
        assert.equal(response.status, 400);
        const body = await response.json() as { error: { code: number } };
        assert.equal(body.error.code, -32020);
      });
    }
    await t.test("malformed JSON does not crash the server", async () => {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders("tools/list"), authorization: `Bearer ${token}` }, body: "{broken-json", signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 400); await response.body?.cancel();
      assert.equal((await fetch(base + "/health")).status, 200);
    });
    await t.test("unsupported modern revision is explicit rather than silently negotiated", async () => {
      const body = rpcEnvelope(++id, "server/discover", {}, true);
      (body.params._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
      const response = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders("server/discover", undefined, true), "mcp-protocol-version": "2099-01-01", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32022);
    });
    await t.test("fixture audit remains off and no retained payload is created", async () => {
      await assert.rejects(stat(audit), { code: "ENOENT" });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
    try { await closed; } finally { clearTimeout(force); }
    await rm(dir, { recursive: true, force: true });
  }
});
