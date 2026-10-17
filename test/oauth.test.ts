import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitUntil(
  predicate: () => string | undefined,
  timeoutMs = 10_000
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for OAuth test server output");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("OAuth DCR + PKCE + refresh protects MCP end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-oauth-"));
  const workspaces = ["A", "B", "C", "D"].map(id => path.join(root, id));
  await Promise.all(workspaces.map(workspace => mkdir(workspace)));
  const port = await getFreePort();
  const publicBase = "https://localcmd.example.test";
  let stdout = "";
  let stderr = "";

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // Keep the developer .env and real audit log out of the test server.
      DOTENV_CONFIG_PATH: path.join(root, "absent.env"),
      LCMCP_LOG_LEVEL: "off",
      LCMCP_AUDIT_LOG: path.join(root, "audit.jsonl"),
      LCMCP_ROOTS: workspaces.join(path.delimiter),
      LCMCP_PORT: String(port),
      LCMCP_AUTH_MODE: "oauth",
      LCMCP_PUBLIC_BASE_URL: publicBase,
      LCMCP_OAUTH_STATE_PATH: path.join(root, "oauth-state.json")
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitUntil(() => stdout.includes("Authentication: oauth") ? "ready" : undefined);

    const base = `http://127.0.0.1:${port}`;

    const unauthenticated = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1.0.0" }
        }
      })
    });
    assert.equal(unauthenticated.status, 401);
    assert.match(
      unauthenticated.headers.get("www-authenticate") || "",
      /oauth-protected-resource/
    );

    const protectedMetadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(protectedMetadata.status, 200);
    assert.deepEqual(await protectedMetadata.json(), {
      resource: publicBase,
      authorization_servers: [publicBase],
      scopes_supported: ["mcp"]
    });

    const asMetadataResponse = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(asMetadataResponse.status, 200);
    const asMetadata = await asMetadataResponse.json() as Record<string, unknown>;
    assert.equal(asMetadata.issuer, publicBase);
    assert.deepEqual(asMetadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(asMetadata.token_endpoint_auth_methods_supported, ["none"]);

    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registrationResponse = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "ChatGPT OAuth Integration Test",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp"
      })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as Record<string, unknown>;
    const clientId = String(registration.client_id || "");
    assert.match(clientId, /^lcmcp_/);

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "oauth-test-state");
    authorizeUrl.searchParams.set("resource", publicBase);
    authorizeUrl.searchParams.set("scope", "mcp");

    const authorizeResponse = await fetch(authorizeUrl);
    assert.equal(authorizeResponse.status, 200);
    assert.match(
      authorizeResponse.headers.get("content-security-policy") || "",
      /form-action 'self' https:\/\/chatgpt\.com/
    );
    const authorizeHtml = await authorizeResponse.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(authorizeHtml)?.[1];
    assert.ok(requestId);

    const approvalCode = await waitUntil(() =>
      /\[oauth\] Approval code: ([A-Z0-9_-]+(?:-[A-Z0-9_-]+)+)/.exec(stdout)?.[1]
    );
    assert.match(stdout, new RegExp(`\\[oauth\\] Request ID: ${requestId}`));

    const approvalResponse = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        approval_code: approvalCode,
        action: "approve"
      }),
      redirect: "manual"
    });
    assert.equal(approvalResponse.status, 302);
    const callback = new URL(approvalResponse.headers.get("location") || "");
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), "oauth-test-state");
    assert.equal(callback.searchParams.get("iss"), publicBase);
    const authorizationCode = callback.searchParams.get("code");
    assert.ok(authorizationCode);

    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: publicBase
      })
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = String(tokens.access_token || "");
    const refreshToken = String(tokens.refresh_token || "");
    assert.ok(accessToken);
    assert.ok(refreshToken);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.scope, "mcp");

    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1.0.0" }
        }
      })
    });
    assert.equal(mcpResponse.status, 200);
    assert.match(await mcpResponse.text(), /local-commander-mcp/);

    const toolsResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {}
      })
    });
    assert.equal(toolsResponse.status, 200);
    const toolsWire = await toolsResponse.text();
    const dataLine = toolsWire
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "));
    const toolsPayload = JSON.parse(
      dataLine ? dataLine.slice(6) : toolsWire
    ) as {
      result?: {
        tools?: Array<{
          _meta?: {
            securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
          };
        }>;
      };
    };
    const listedTools = toolsPayload.result?.tools ?? [];
    assert.ok(listedTools.length >= 15);
    for (const tool of listedTools) {
      assert.deepEqual(tool._meta?.securitySchemes, [
        { type: "oauth2", scopes: ["mcp"] }
      ]);
    }

    const parallelResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "parallel_command_run",
          arguments: {
            commands: ["A", "B", "C", "D"].map((id) => ({
              id,
              command: "node",
              args: [
                "-e",
                `setTimeout(()=>console.log('${id} done'),300)`
              ],
              cwd: path.join(root, id),
              timeoutMs: 5000
            }))
          }
        }
      })
    });
    assert.equal(parallelResponse.status, 200);
    const parallelWire = await parallelResponse.text();
    const parallelDataLine = parallelWire
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "));
    const parallelPayload = JSON.parse(
      parallelDataLine ? parallelDataLine.slice(6) : parallelWire
    ) as {
      result?: {
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    const parallelText = parallelPayload.result?.content?.find((item) => item.type === "text")?.text;
    assert.ok(parallelText);
    const parallelResult = JSON.parse(parallelText) as {
      parallel: boolean;
      count: number;
      succeeded: number;
      failed: number;
      durationMs: number;
      results: Array<{ id: string; ok: boolean; stdout?: string }>;
    };
    assert.equal(parallelResult.parallel, true);
    assert.equal(parallelResult.count, 4);
    assert.equal(parallelResult.succeeded, 4);
    assert.equal(parallelResult.failed, 0);
    assert.ok(
      parallelResult.durationMs < 1000,
      `parallel batch took ${parallelResult.durationMs}ms; expected substantially less than sequential execution`
    );
    assert.deepEqual(
      parallelResult.results.map((item) => item.id),
      ["A", "B", "C", "D"]
    );
    for (const item of parallelResult.results) {
      assert.equal(item.ok, true);
      assert.match(item.stdout ?? "", new RegExp(`^${item.id} done`));
    }

    // Generic commands in one workspace must preserve ordered effects, even through the batch tool.
    const orderedResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: {
          name: "parallel_command_run",
          arguments: {
            commands: [
              { id: "write", script: "setTimeout(()=>require('node:fs').writeFileSync('ordered.txt','first finished'),150)" },
              { id: "read", script: "console.log(require('node:fs').readFileSync('ordered.txt','utf8'))" }
            ].map(({ id, script }) => ({ id, command: "node", args: ["-e", script], cwd: workspaces[0], timeoutMs: 5000 }))
          }
        }
      })
    });
    assert.equal(orderedResponse.status, 200);
    const orderedWire = await orderedResponse.text();
    const orderedData = orderedWire.split(/\r?\n/).find(line => line.startsWith("data: "));
    const orderedPayload = JSON.parse(orderedData ? orderedData.slice(6) : orderedWire);
    const ordered = JSON.parse(orderedPayload.result.content.find((item: { type: string }) => item.type === "text").text);
    assert.equal(ordered.failed, 0);
    assert.equal(ordered.succeeded, 2);
    assert.equal(ordered.results[1].stdout.trim(), "first finished");

    const refreshResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: publicBase
      })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    assert.ok(String(refreshed.access_token || ""));
    assert.ok(String(refreshed.refresh_token || ""));
  } finally {
    await stopProcess(child);
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("request failed"), false, stderr);
});
