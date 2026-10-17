import type { IncomingMessage, ServerResponse } from "node:http";
import { localhostAllowedHostnames, validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import type { AppConfig } from "./config.js";

/**
 * Native HTTP only. Trust comes from startup configuration, never Host/Forwarded
 * input, OAuth redirect URIs, or self-reported client metadata. This is an
 * additional browser/DNS-rebinding boundary, not a substitute for bearer/OAuth.
 */
export function createNativeHttpBoundary(config: Pick<AppConfig, "server" | "auth">) {
  const { port, host } = config.server;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_HTTP_PORT");
  const hostnames = new Set(localhostAllowedHostnames());
  const origins = new Set([...hostnames].map((name) => new URL(`http://${name}:${port}`).origin));

  // Wildcard bind addresses are not valid browser origins or trusted hostnames.
  const bind = host.trim().toLowerCase();
  if (!bind) throw new Error("INVALID_HTTP_BIND_HOST");
  if (!["0.0.0.0", "::", "[::]"].includes(bind)) {
    const bracketed = bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
    let parsed: URL;
    try { parsed = new URL(`http://${bracketed}:${port}`); }
    catch { throw new Error("INVALID_HTTP_BIND_HOST"); }
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("INVALID_HTTP_BIND_HOST");
    }
    hostnames.add(parsed.hostname);
    origins.add(parsed.origin);
  }

  if (config.auth.publicBaseUrl) {
    let publicUrl: URL;
    try { publicUrl = new URL(config.auth.publicBaseUrl); }
    catch { throw new Error("INVALID_PUBLIC_HTTP_ORIGIN"); }
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password ||
        publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
      throw new Error("INVALID_PUBLIC_HTTP_ORIGIN");
    }
    hostnames.add(publicUrl.hostname);
    origins.add(publicUrl.origin);
  }
  const allowedHostnames = [...hostnames];
  // Extra trusted browser origins (e.g. the ChatGPT web app) widen the Origin
  // check only; they are never accepted as a Host.
  const originHostnames = new Set(allowedHostnames);
  for (const entry of config.auth.allowedOrigins ?? []) {
    let extra: URL;
    try { extra = new URL(entry); } catch { throw new Error("INVALID_ALLOWED_ORIGIN"); }
    if (extra.protocol !== "https:" || extra.username || extra.password ||
        extra.pathname !== "/" || extra.search || extra.hash) {
      throw new Error("INVALID_ALLOWED_ORIGIN");
    }
    originHostnames.add(extra.hostname);
    origins.add(extra.origin);
  }
  const allowedOriginHostnames = [...originHostnames];

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // Node can join or discard duplicates. Never validate only the surviving value.
    let hostCount = 0;
    let originCount = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i]?.toLowerCase();
      if (key === "host") hostCount += 1;
      if (key === "origin") originCount += 1;
    }
    const hostHeader = req.headers.host;
    if (hostCount !== 1 || typeof hostHeader !== "string" ||
        /[\s/\\?#@%,]/.test(hostHeader) || !validateHostHeader(hostHeader, allowedHostnames).ok) {
      return deny(res, "HOST_NOT_ALLOWED", req);
    }
    if (originCount === 0 && req.headers.origin === undefined) return true;
    const originHeader = req.headers.origin;
    if (originCount !== 1 || typeof originHeader !== "string" || !originHeader ||
        /\s/.test(originHeader) || !validateOriginHeader(originHeader, allowedOriginHostnames).ok) {
      return deny(res, "ORIGIN_NOT_ALLOWED", req);
    }
    let origin: URL;
    try { origin = new URL(originHeader); }
    catch { return deny(res, "ORIGIN_NOT_ALLOWED", req); }
    // SDK allowlists are hostname-only. Enforce the actual configured scheme and
    // port as well; another service on localhost must not become a trusted origin.
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash ||
        /[\\?#]/.test(originHeader) || !origins.has(origin.origin)) {
      return deny(res, "ORIGIN_NOT_ALLOWED", req);
    }
    return true;
  };
}

function deny(res: ServerResponse, reason: "HOST_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED", req?: IncomingMessage): false {
  if (req) {
    // Diagnostics only: method, path without query, and the two boundary headers. No credentials.
    const clip = (value: unknown) => String(Array.isArray(value) ? value.join(",") : value ?? "").slice(0, 200);
    console.error(JSON.stringify({ boundaryDenied: reason, method: req.method, path: (req.url ?? "").split("?")[0]?.slice(0, 200),
      host: clip(req.headers.host), origin: clip(req.headers.origin) }));
  }
  res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  // Do not reflect attacker-controlled headers (which can contain credentials).
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: reason } }));
  return false;
}
