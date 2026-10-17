import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AuthMode = "bearer" | "oauth" | "none";

export interface AppConfig {
  roots: string[];
  server: {
    host: string;
    port: number;
    mcpPath: string;
  };
  auth: {
    mode: AuthMode;
    token?: string;
    publicBaseUrl?: string;
    /** Extra HTTPS browser origins (e.g. https://chatgpt.com) trusted by the Origin check only, never the Host check. */
    allowedOrigins?: string[];
    oauthStatePath: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    authorizationCodeTtlSec: number;
    approvalCodeTtlSec: number;
  };
  files: {
    maxReadBytes: number;
    maxWriteBytes: number;
    maxSearchFileBytes: number;
    allowSensitiveFiles: boolean;
  };
  shell: {
    allowedCommands: string[];
    maxTimeoutMs: number;
    maxOutputBytes: number;
    maxProcesses: number;
  };
  http: {
    allowedHosts: string[];
    maxResponseBytes: number;
    timeoutMs: number;
  };
}

const DEFAULT_COMMANDS = [
  "git",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "py",
  "dotnet",
  "go",
  "cargo",
  "rustc"
];

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : fallback;
}

function normalizeMcpPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "/mcp";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function loadConfig(): AppConfig {
  const configPath = path.resolve(
    process.env.LCMCP_CONFIG?.trim() || path.join(process.cwd(), "local-commander.config.json")
  );

  let raw: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, any>;
    } catch (error) {
      throw new Error(`Cannot parse config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const envRoots = process.env.LCMCP_ROOTS
    ?.split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);

  const roots = (envRoots?.length ? envRoots : asStringArray(raw.roots, []))
    .map((root) => path.resolve(root));

  if (roots.length === 0) {
    throw new Error(
      "No allowed roots configured. Set roots in local-commander.config.json or LCMCP_ROOTS."
    );
  }

  const envMode = process.env.LCMCP_AUTH_MODE?.trim().toLowerCase();
  const rawMode = typeof raw.auth?.mode === "string" ? raw.auth.mode.toLowerCase() : undefined;
  const selectedMode = envMode || rawMode || "bearer";
  if (!["bearer", "oauth", "none"].includes(selectedMode)) {
    throw new Error(`Unsupported auth mode: ${selectedMode}`);
  }
  const authMode = selectedMode as AuthMode;
  const token = process.env.LCMCP_TOKEN?.trim() || (typeof raw.auth?.token === "string" ? raw.auth.token.trim() : "");
  const publicBaseUrlRaw =
    process.env.LCMCP_PUBLIC_BASE_URL?.trim() ||
    (typeof raw.auth?.publicBaseUrl === "string" ? raw.auth.publicBaseUrl.trim() : "");
  let publicBaseUrl: string | undefined;

  if (publicBaseUrlRaw) {
    const parsed = new URL(publicBaseUrlRaw);
    if (parsed.protocol !== "https:") {
      throw new Error("auth.publicBaseUrl / LCMCP_PUBLIC_BASE_URL must use https");
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      throw new Error("auth.publicBaseUrl must be an HTTPS origin only, without path, credentials, query parameters, or fragments");
    }
    publicBaseUrl = parsed.origin;
  }

  const allowedOrigins: string[] = [...new Set<string>(
    (process.env.LCMCP_ALLOWED_ORIGINS ?? (Array.isArray(raw.auth?.allowedOrigins) ? raw.auth.allowedOrigins.join(",") : ""))
      .split(",").map((entry: string) => entry.trim()).filter(Boolean)
      .map((entry: string) => {
        let parsed: URL;
        try { parsed = new URL(entry); } catch { throw new Error("INVALID_ALLOWED_ORIGIN"); }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
            parsed.pathname !== "/") {
          throw new Error("INVALID_ALLOWED_ORIGIN");
        }
        return parsed.origin;
      })
  )];

  if (authMode === "bearer" && !token) {
    throw new Error(
      "Bearer authentication is enabled but no token is configured. Set LCMCP_TOKEN."
    );
  }
  if (authMode === "oauth" && !publicBaseUrl) {
    throw new Error(
      "OAuth authentication requires LCMCP_PUBLIC_BASE_URL or auth.publicBaseUrl, for example https://localcmd.example.com"
    );
  }

  const config: AppConfig = {
    roots,
    server: {
      host: process.env.LCMCP_HOST?.trim() || raw.server?.host || "127.0.0.1",
      port: asPositiveInt(process.env.LCMCP_PORT ?? raw.server?.port, 17321),
      mcpPath: normalizeMcpPath(process.env.LCMCP_MCP_PATH ?? raw.server?.mcpPath)
    },
    auth: {
      mode: authMode,
      ...(token ? { token } : {}),
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      ...(allowedOrigins.length ? { allowedOrigins } : {}),
      oauthStatePath: path.resolve(
        process.env.LCMCP_OAUTH_STATE_PATH?.trim() ||
        (typeof raw.auth?.oauthStatePath === "string" ? raw.auth.oauthStatePath : ".local-commander-oauth.json")
      ),
      accessTokenTtlSec: asPositiveInt(raw.auth?.accessTokenTtlSec, 3600),
      refreshTokenTtlSec: asPositiveInt(raw.auth?.refreshTokenTtlSec, 30 * 24 * 3600),
      authorizationCodeTtlSec: asPositiveInt(raw.auth?.authorizationCodeTtlSec, 300),
      approvalCodeTtlSec: asPositiveInt(raw.auth?.approvalCodeTtlSec, 900)
    },
    files: {
      maxReadBytes: asPositiveInt(raw.files?.maxReadBytes, 512 * 1024),
      maxWriteBytes: asPositiveInt(raw.files?.maxWriteBytes, 1024 * 1024),
      maxSearchFileBytes: asPositiveInt(raw.files?.maxSearchFileBytes, 256 * 1024),
      allowSensitiveFiles: raw.files?.allowSensitiveFiles === true
    },
    shell: {
      allowedCommands: asStringArray(raw.shell?.allowedCommands, DEFAULT_COMMANDS)
        .map((command) => command.toLowerCase()),
      maxTimeoutMs: asPositiveInt(raw.shell?.maxTimeoutMs, 240_000),
      maxOutputBytes: asPositiveInt(raw.shell?.maxOutputBytes, 1024 * 1024),
      maxProcesses: asPositiveInt(raw.shell?.maxProcesses, 12)
    },
    http: {
      allowedHosts: asStringArray(raw.http?.allowedHosts, ["127.0.0.1", "localhost", "::1"])
        .map((host) => host.toLowerCase()),
      maxResponseBytes: asPositiveInt(raw.http?.maxResponseBytes, 1024 * 1024),
      timeoutMs: asPositiveInt(raw.http?.timeoutMs, 30_000)
    }
  };

  return config;
}
