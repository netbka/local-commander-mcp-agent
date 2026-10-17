#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { AuditLogger } from "./audit.js";
import { AGENT_STARTUP_INSTRUCTIONS } from "./agent-instructions.js";
import { loadConfig } from "./config.js";
import { PathGuard } from "./guard.js";
import { createNativeHttpBoundary } from "./http-boundary.js";
import { getBearerToken, OAuthServer } from "./oauth.js";
import { ProcessManager } from "./process.js";
import { ExecutionScheduler } from "./scheduler.js";
import { registerTools } from "./tools.js";

function packageVersion(): string {
  try {
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && version ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = packageVersion();

function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stdioRequested(): boolean {
  return process.argv.slice(2).includes("--stdio") || process.env.LCMCP_TRANSPORT?.trim().toLowerCase() === "stdio";
}

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(process.argv.slice(3));
    return;
  }
  const stdio = stdioRequested();
  if (stdio) {
    // stdout carries only MCP frames; the pipe belongs to the spawning client, so HTTP auth does not apply.
    console.log = console.error;
    console.info = console.error;
    process.env.LCMCP_AUTH_MODE = "none";
    // Clients pass multi-folder settings as separate arguments; their working directory is unpredictable.
    const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
    if (roots.length > 0) process.env.LCMCP_ROOTS = roots.join(path.delimiter);
    process.env.LCMCP_OAUTH_STATE_PATH ||= path.join(os.homedir(), ".local-commander-mcp-agent", "state.json");
  }
  const config = loadConfig();
  const allowHttpRequest = createNativeHttpBoundary(config);
  const audit = new AuditLogger({ monitorDirectory: path.join(path.dirname(config.auth.oauthStatePath), ".local-commander", "activity") });
  const guard = await PathGuard.create(config.roots, config.files.allowSensitiveFiles, {
    protectedPaths: [
      config.auth.oauthStatePath,
      audit.filePath,
      path.resolve(process.env.LCMCP_CONFIG?.trim() || "local-commander.config.json")
    ]
  });
  const processes = new ProcessManager(config, guard);
  const reclaimed = await processes.reclaimOrphans();
  if (reclaimed > 0) console.log(`Reclaimed ${reclaimed} process(es) left by a previous run`);
  const scheduler = new ExecutionScheduler(undefined, guard);
  const createServerInstance = () => {
    const server = new McpServer({
      name: "local-commander-mcp",
      version: VERSION
    }, { instructions: AGENT_STARTUP_INSTRUCTIONS });
    registerTools(server, config, guard, processes, audit, scheduler);
    return server;
  };

  if (stdio) {
    const connection = serveStdio(createServerInstance, {
      onerror: (error) => console.error("[stdio]", error.message)
    });
    console.error(`local-commander-mcp v${VERSION} (stdio)`);
    console.error(`Allowed roots: ${guard.roots.length}`);
    console.error("Telemetry: disabled (no telemetry implementation is present)");
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await processes.killAll();
      await connection.close();
    };
    process.stdin.once("end", () => {
      void close().finally(() => process.exit(0));
    });
    process.once("SIGINT", () => {
      void close().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void close().finally(() => process.exit(0));
    });
    return;
  }

  const oauth = config.auth.mode === "oauth" ? await OAuthServer.create(config) : undefined;

  const handler = createMcpHandler(createServerInstance, { responseMode: "json" });

  const nodeHandler = toNodeHandler(handler);

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowHttpRequest(req, res)) return;
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    const method = req.method ?? "GET";

    if ((method === "GET" || method === "HEAD") && pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(JSON.stringify({
          status: "ok",
          version: VERSION,
          authentication: config.auth.mode
        }));
      }
      return;
    }

    if (oauth) {
      const handled = await oauth.handle(req, res, {
        method,
        pathname,
        query: requestUrl.searchParams
      });
      if (handled) return;
    }

    if (pathname !== config.server.mcpPath) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (config.auth.mode === "bearer") {
      const provided = getBearerToken(req.headers.authorization);
      if (!provided || !config.auth.token || !tokenMatches(provided, config.auth.token)) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", 'Bearer realm="local-commander-mcp"');
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (oauth) {
      const provided = getBearerToken(req.headers.authorization);
      if (!provided) {
        oauth.unauthorized(res);
        return;
      }

      try {
        oauth.verifyAccessToken(provided);
      } catch (error) {
        oauth.unauthorized(res, error instanceof Error ? error.message : "invalid access token");
        return;
      }
    }

    await nodeHandler(req, res);
  }

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("[http] request failed:", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "internal_server_error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.server.port, config.server.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.log(`local-commander-mcp v${VERSION}`);
  console.log(`MCP: http://${config.server.host}:${config.server.port}${config.server.mcpPath}`);
  console.log(`Health: http://${config.server.host}:${config.server.port}/health`);
  console.log(`Allowed roots: ${guard.roots.length}`);
  console.log(`Authentication: ${config.auth.mode}`);
  console.log(`MCP traffic log: ${audit.level} -> ${audit.filePath}`);
  console.log(`Scheduler limits: read=${scheduler.limits.read} wait=${scheduler.limits.wait} general=${scheduler.limits.general} cpu=${scheduler.limits.cpu}`);
  if (oauth) {
    console.log(`Public OAuth resource: ${oauth.resource}`);
    console.log(`OAuth metadata: ${oauth.metadataUrl}`);
    console.log("OAuth approval: one-time code printed in this terminal");
  }
  console.log("Telemetry: disabled (no telemetry implementation is present)");
  if (config.auth.mode === "none") {
    console.warn(
      "WARNING: MCP authentication is disabled. Do not expose this endpoint publicly unless the tunnel/edge restricts callers."
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down local-commander-mcp...");
    await processes.killAll();
    await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
