import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  throw new Error("timed out waiting for OAuth restart test server output");
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

function startOAuthServer(args: {
  root: string;
  port: number;
  publicBase: string;
  statePath: string;
}): {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // Keep the developer .env and real audit log out of the test server.
      DOTENV_CONFIG_PATH: path.join(args.root, "absent.env"),
      LCMCP_LOG_LEVEL: "off",
      LCMCP_AUDIT_LOG: path.join(args.root, "audit.jsonl"),
      LCMCP_ROOTS: args.root,
      LCMCP_PORT: String(args.port),
      LCMCP_AUTH_MODE: "oauth",
      LCMCP_PUBLIC_BASE_URL: args.publicBase,
      LCMCP_OAUTH_STATE_PATH: args.statePath
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

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

test("OAuth authorization survives restart before approval and token exchange", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-oauth-restart-"));
  const port = await getFreePort();
  const publicBase = "https://localcmd.restart.test";
  const statePath = path.join(root, "oauth-state.json");
  const base = `http://127.0.0.1:${port}`;
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  let first: ReturnType<typeof startOAuthServer> | undefined;
  let second: ReturnType<typeof startOAuthServer> | undefined;
  let third: ReturnType<typeof startOAuthServer> | undefined;
  const capturedStderr: string[] = [];

  try {
    first = startOAuthServer({ root, port, publicBase, statePath });
    await waitUntil(() => first?.stdout().includes("Authentication: oauth") ? "ready" : undefined);

    const registrationResponse = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "ChatGPT OAuth Restart Test",
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
    authorizeUrl.searchParams.set("state", "restart-test-state");
    authorizeUrl.searchParams.set("resource", publicBase);
    authorizeUrl.searchParams.set("scope", "mcp");

    const authorizeResponse = await fetch(authorizeUrl);
    assert.equal(authorizeResponse.status, 200);
    const authorizeHtml = await authorizeResponse.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(authorizeHtml)?.[1];
    assert.ok(requestId);

    const approvalCode = await waitUntil(() =>
      /\[oauth\] Approval code: ([A-Z0-9_-]+(?:-[A-Z0-9_-]+)+)/.exec(first?.stdout() ?? "")?.[1]
    );
    assert.ok(approvalCode);

    await stopProcess(first.child);
    capturedStderr.push(first.stderr());
    first = undefined;

    second = startOAuthServer({ root, port, publicBase, statePath });
    await waitUntil(() => second?.stdout().includes("Authentication: oauth") ? "ready" : undefined);

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
    assert.equal(callback.searchParams.get("state"), "restart-test-state");
    const authorizationCode = callback.searchParams.get("code");
    assert.ok(authorizationCode);

    await stopProcess(second.child);
    capturedStderr.push(second.stderr());
    second = undefined;

    third = startOAuthServer({ root, port, publicBase, statePath });
    await waitUntil(() => third?.stdout().includes("Authentication: oauth") ? "ready" : undefined);

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
    assert.ok(accessToken);

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
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-restart-test", version: "1.0.0" }
        }
      })
    });
    assert.equal(mcpResponse.status, 200);
    assert.match(await mcpResponse.text(), /local-commander-mcp/);
  } finally {
    if (first) {
      await stopProcess(first.child);
      capturedStderr.push(first.stderr());
    }
    if (second) {
      await stopProcess(second.child);
      capturedStderr.push(second.stderr());
    }
    if (third) {
      await stopProcess(third.child);
      capturedStderr.push(third.stderr());
    }
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(
    capturedStderr.some((value) => value.includes("request failed")),
    false,
    capturedStderr.join("\n")
  );
});
