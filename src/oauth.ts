import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  scope: string;
}

interface PersistedOAuthState {
  version: 1;
  signingSecret: string;
  clients: RegisteredClient[];
  pendingAuthorizations?: PendingAuthorization[];
  authorizationCodes?: Array<{ code: string; value: AuthorizationCode }>;
  refreshTokens?: Array<{ jti: string; value: RefreshTokenRecord }>;
}

/** One-time refresh token. Presenting a jti that is no longer active revokes its whole family (replay detection). */
interface RefreshTokenRecord {
  clientId: string;
  familyId: string;
  expiresAtMs: number;
}

// Local OAuth abuse bounds. Every /authorize GET prints an approval code and persists state, so it is
// metered like registration; pending requests and stored refresh tokens are capped with oldest-first eviction.
const AUTHORIZE_REQUESTS_PER_MINUTE = 10;
const MAX_PENDING_AUTHORIZATIONS = 20;
const MAX_REGISTERED_CLIENTS = 250;
const MAX_ACTIVE_REFRESH_TOKENS = 200;

interface PendingAuthorization {
  requestId: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  approvalHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  attempts: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  expiresAtMs: number;
}

interface JwtPayload {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  client_id: string;
  token_use: "access" | "refresh";
  iat: number;
  exp: number;
  jti: string;
  /** Refresh-token family (rotation lineage); absent on access tokens. */
  fam?: string;
}

interface OAuthRequestContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
}

interface DcrBody {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

function json(
  res: ServerResponse,
  status: number,
  body: JsonObject,
  headers: Record<string, string> = {}
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function html(
  res: ServerResponse,
  status: number,
  body: string,
  formActionOrigins: string[] = []
): void {
  const allowedFormActions = [
    "'self'",
    ...formActionOrigins.filter((origin) => /^https?:\/\/[^\s;]+$/i.test(origin))
  ].join(" ");

  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  // `no-referrer` makes browsers send `Origin: null` on the approval form POST, which the
  // native HTTP boundary must reject. `same-origin` leaks nothing cross-site.
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${allowedFormActions}; base-uri 'none'; frame-ancestors 'none'`
  );
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64url(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64url");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeScope(scope: string | undefined): string {
  const requested = (scope || "mcp")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (requested.length === 0) return "mcp";
  if (requested.some((item) => item !== "mcp")) {
    throw new Error("Only the mcp scope is supported");
  }
  return "mcp";
}

function isAllowedRedirectUri(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;

  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value as string[];
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const contentType = (req.headers["content-type"] || "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("content-type must be application/x-www-form-urlencoded");
  }
  const body = await readBody(req, 32 * 1024);
  return new URLSearchParams(body.toString("utf8"));
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const contentType = (req.headers["content-type"] || "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("content-type must be application/json");
  }
  const body = await readBody(req, 64 * 1024);
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as JsonObject;
}

function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function authorizationPage(args: {
  requestId: string;
  clientName: string;
  scope: string;
  resource: string;
  error?: string;
}): string {
  const errorHtml = args.error
    ? `<div class="error">${escapeHtml(args.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize local-commander-mcp</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#17191c;margin:0;padding:24px}
.card{max-width:520px;margin:8vh auto;background:#fff;border:1px solid #ddd;border-radius:14px;padding:28px;box-shadow:0 12px 35px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.45}.muted{color:#636a73;font-size:14px}
label{display:block;font-weight:650;margin:22px 0 8px}
input{box-sizing:border-box;width:100%;font-size:19px;letter-spacing:.08em;padding:12px;border:1px solid #b6bcc5;border-radius:9px}
.actions{display:flex;gap:10px;margin-top:18px}button{border:0;border-radius:9px;padding:11px 16px;font-weight:650;cursor:pointer}
.approve{background:#17191c;color:#fff}.deny{background:#eceff2;color:#17191c}.error{background:#fff1f1;color:#8d1d1d;padding:10px;border-radius:8px;margin:12px 0}
code{font-size:13px}
</style>
</head>
<body>
<div class="card">
<h1>Authorize local-commander-mcp</h1>
<p><strong>${escapeHtml(args.clientName)}</strong> is requesting access to your local development MCP.</p>
<p class="muted">Resource: <code>${escapeHtml(args.resource)}</code><br>Scope: <code>${escapeHtml(args.scope)}</code></p>
${errorHtml}
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(args.requestId)}">
<label for="approval_code">Approval code from your local terminal</label>
<input id="approval_code" name="approval_code" autocomplete="one-time-code" required autofocus>
<div class="actions">
<button class="approve" type="submit" name="action" value="approve">Authorize</button>
<button class="deny" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
</div>
</form>
<p class="muted">The approval code is one-time and expires quickly. No reusable password is sent through the tunnel.</p>
</div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAuth error</title><style>body{font-family:system-ui;background:#f6f7f9;padding:24px}.card{max-width:560px;margin:10vh auto;background:#fff;border:1px solid #ddd;border-radius:14px;padding:28px}code{word-break:break-word}</style></head>
<body><div class="card"><h1>Authorization failed</h1><p><code>${escapeHtml(message)}</code></p></div></body></html>`;
}

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly metadataUrl: string;

  private signingSecret = "";
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly registrationTimestamps: number[] = [];
  private readonly authorizeTimestamps: number[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(private readonly config: AppConfig) {
    if (!config.auth.publicBaseUrl) throw new Error("OAuth requires auth.publicBaseUrl");
    this.issuer = config.auth.publicBaseUrl.replace(/\/$/, "");
    this.resource = this.issuer;
    this.metadataUrl = `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  static async create(config: AppConfig): Promise<OAuthServer> {
    const server = new OAuthServer(config);
    await server.loadState();
    return server;
  }

  private async loadState(): Promise<void> {
    const statePath = this.config.auth.oauthStatePath;
    let state: PersistedOAuthState | undefined;

    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as PersistedOAuthState;
      if (
        parsed?.version === 1 &&
        typeof parsed.signingSecret === "string" &&
        Array.isArray(parsed.clients)
      ) {
        state = parsed;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    if (!state) {
      state = {
        version: 1,
        signingSecret: randomToken(48),
        clients: []
      };
      await this.persistState(state);
    }

    this.signingSecret = state.signingSecret;
    for (const client of state.clients) {
      if (client && typeof client.client_id === "string" && Array.isArray(client.redirect_uris)) {
        this.clients.set(client.client_id, client);
      }
    }

    const now = Date.now();
    for (const pending of state.pendingAuthorizations ?? []) {
      if (
        pending &&
        typeof pending.requestId === "string" &&
        typeof pending.expiresAtMs === "number" &&
        pending.expiresAtMs > now
      ) {
        this.pending.set(pending.requestId, pending);
      }
    }
    for (const entry of state.authorizationCodes ?? []) {
      if (
        entry &&
        typeof entry.code === "string" &&
        entry.value &&
        typeof entry.value.expiresAtMs === "number" &&
        entry.value.expiresAtMs > now
      ) {
        this.authorizationCodes.set(entry.code, entry.value);
      }
    }
    for (const entry of state.refreshTokens ?? []) {
      if (
        entry &&
        typeof entry.jti === "string" &&
        entry.value &&
        typeof entry.value.clientId === "string" &&
        typeof entry.value.familyId === "string" &&
        typeof entry.value.expiresAtMs === "number" &&
        entry.value.expiresAtMs > now
      ) {
        this.refreshTokens.set(entry.jti, entry.value);
      }
    }
  }

  private async persistSnapshot(): Promise<void> {
    const task = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistState({
        version: 1,
        signingSecret: this.signingSecret,
        clients: [...this.clients.values()],
        pendingAuthorizations: [...this.pending.values()],
        authorizationCodes: [...this.authorizationCodes.entries()].map(([code, value]) => ({
          code,
          value
        })),
        refreshTokens: [...this.refreshTokens.entries()].map(([jti, value]) => ({ jti, value }))
      }));
    this.persistChain = task;
    await task;
  }

  private async persistState(state: PersistedOAuthState): Promise<void> {
    const statePath = this.config.auth.oauthStatePath;
    await mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempPath, statePath);
  }

  private signJwt(payload: JwtPayload): string {
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = base64url(JSON.stringify(payload));
    const signingInput = `${header}.${body}`;
    const signature = createHmac("sha256", this.signingSecret)
      .update(signingInput)
      .digest("base64url");
    return `${signingInput}.${signature}`;
  }

  private verifyJwt(token: string, expectedUse: "access" | "refresh"): JwtPayload {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token format");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const expectedSignature = createHmac("sha256", this.signingSecret)
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");

    if (!safeEqualText(signaturePart, expectedSignature)) throw new Error("invalid token signature");

    let header: JsonObject;
    let payload: JwtPayload;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as JsonObject;
      payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as JwtPayload;
    } catch {
      throw new Error("invalid token encoding");
    }

    if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error("invalid token header");
    if (payload.iss !== this.issuer) throw new Error("invalid token issuer");
    if (payload.aud !== this.resource) throw new Error("invalid token audience");
    if (payload.token_use !== expectedUse) throw new Error("invalid token use");
    if (payload.exp <= nowSeconds()) throw new Error("token expired");
    if (payload.iat > nowSeconds() + 60) throw new Error("token issued in the future");
    if (!payload.scope.split(/\s+/).includes("mcp")) throw new Error("missing mcp scope");
    if (!this.clients.has(payload.client_id)) throw new Error("unknown OAuth client");
    return payload;
  }

  verifyAccessToken(token: string): JwtPayload {
    return this.verifyJwt(token, "access");
  }

  /** Issues tokens; the refresh token (if any) is recorded as the single active member of `familyId`. Caller persists. */
  private issueTokens(clientId: string, scope: string, familyId = randomToken(12)): JsonObject {
    const now = nowSeconds();
    const accessToken = this.signJwt({
      iss: this.issuer,
      sub: "local-owner",
      aud: this.resource,
      scope,
      client_id: clientId,
      token_use: "access",
      iat: now,
      exp: now + this.config.auth.accessTokenTtlSec,
      jti: randomToken(18)
    });
    const client = this.clients.get(clientId);
    const canRefresh = client?.grant_types.includes("refresh_token") === true;
    let refreshToken: string | undefined;
    if (canRefresh) {
      const jti = randomToken(18);
      const exp = now + this.config.auth.refreshTokenTtlSec;
      refreshToken = this.signJwt({
        iss: this.issuer,
        sub: "local-owner",
        aud: this.resource,
        scope,
        client_id: clientId,
        token_use: "refresh",
        iat: now,
        exp,
        jti,
        fam: familyId
      });
      this.evictOldest(this.refreshTokens, MAX_ACTIVE_REFRESH_TOKENS - 1, (record) => record.expiresAtMs);
      this.refreshTokens.set(jti, { clientId, familyId, expiresAtMs: exp * 1000 });
    }

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.auth.accessTokenTtlSec,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope
    };
  }

  protectedResourceMetadata(): JsonObject {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ["mcp"]
    };
  }

  authorizationServerMetadata(): JsonObject {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
      authorization_response_iss_parameter_supported: true
    };
  }

  unauthorized(res: ServerResponse, description?: string): void {
    const challenge = [
      `Bearer resource_metadata="${this.metadataUrl}"`,
      'scope="mcp"',
      ...(description ? [`error="invalid_token"`, `error_description="${description.replaceAll('"', "'")}"`] : [])
    ].join(", ");
    json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
  }

  async handle(req: IncomingMessage, res: ServerResponse, ctx: OAuthRequestContext): Promise<boolean> {
    await this.cleanupExpired();

    if (
      ctx.method === "GET" &&
      (ctx.pathname === "/.well-known/oauth-protected-resource" ||
        ctx.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      json(res, 200, this.protectedResourceMetadata());
      return true;
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/.well-known/oauth-authorization-server"
    ) {
      json(res, 200, this.authorizationServerMetadata());
      return true;
    }

    if (ctx.pathname === "/register" && ctx.method === "POST") {
      await this.handleRegistration(req, res);
      return true;
    }

    if (ctx.pathname === "/authorize" && ctx.method === "GET") {
      await this.handleAuthorizeGet(res, ctx.query);
      return true;
    }

    if (ctx.pathname === "/authorize" && ctx.method === "POST") {
      await this.handleAuthorizePost(req, res);
      return true;
    }

    if (ctx.pathname === "/token" && ctx.method === "POST") {
      await this.handleToken(req, res);
      return true;
    }

    return false;
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [key, value] of this.pending) {
      if (value.expiresAtMs <= now) {
        this.pending.delete(key);
        changed = true;
      }
    }
    for (const [key, value] of this.authorizationCodes) {
      if (value.expiresAtMs <= now) {
        this.authorizationCodes.delete(key);
        changed = true;
      }
    }
    for (const [key, value] of this.refreshTokens) {
      if (value.expiresAtMs <= now) {
        this.refreshTokens.delete(key);
        changed = true;
      }
    }

    const cutoff = now - 60_000;
    for (const timestamps of [this.registrationTimestamps, this.authorizeTimestamps]) {
      while (timestamps.length && timestamps[0]! < cutoff) timestamps.shift();
    }

    if (changed) await this.persistSnapshot();
  }

  /** Drops the entries that expire soonest until at most `keep` remain. Maps preserve insertion order, so ties keep the newest. */
  private evictOldest<T>(map: Map<string, T>, keep: number, expiresAt: (value: T) => number): void {
    if (map.size <= keep) return;
    const ordered = [...map.entries()].sort((a, b) => expiresAt(a[1]) - expiresAt(b[1]));
    for (const [key] of ordered.slice(0, map.size - keep)) map.delete(key);
  }

  /** Every active refresh token descending from the same authorization is revoked together. */
  private revokeRefreshFamily(familyId: string): void {
    for (const [jti, record] of this.refreshTokens) {
      if (record.familyId === familyId) this.refreshTokens.delete(jti);
    }
  }

  private async handleRegistration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.registrationTimestamps.length >= 20) {
      json(res, 429, { error: "too_many_requests" });
      return;
    }
    this.registrationTimestamps.push(Date.now());

    let body: DcrBody;
    try {
      body = await readJson(req) as DcrBody;
    } catch (error) {
      json(res, 400, {
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    try {
      const redirectUris = parseStringArray(body.redirect_uris, "redirect_uris");
      if (redirectUris.length > 10 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
        throw new Error("redirect_uris must contain at most 10 HTTPS or loopback HTTP URLs");
      }

      const tokenMethod =
        typeof body.token_endpoint_auth_method === "string"
          ? body.token_endpoint_auth_method
          : "none";
      if (tokenMethod !== "none") {
        throw new Error("only token_endpoint_auth_method=none is supported");
      }

      const grantTypes = body.grant_types === undefined
        ? ["authorization_code", "refresh_token"]
        : parseStringArray(body.grant_types, "grant_types");
      if (grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value))) {
        throw new Error("unsupported grant_type requested");
      }
      if (!grantTypes.includes("authorization_code")) {
        throw new Error("authorization_code grant is required");
      }

      const responseTypes = body.response_types === undefined
        ? ["code"]
        : parseStringArray(body.response_types, "response_types");
      if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
        throw new Error("only response_type=code is supported");
      }

      const scope = normalizeScope(typeof body.scope === "string" ? body.scope : undefined);
      const client: RegisteredClient = {
        client_id: `lcmcp_${randomToken(24)}`,
        client_id_issued_at: nowSeconds(),
        ...(typeof body.client_name === "string" && body.client_name.trim()
          ? { client_name: body.client_name.trim().slice(0, 200) }
          : {}),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: grantTypes,
        response_types: responseTypes,
        scope
      };

      // Registration is unauthenticated: never evict an existing client's authorization.
      // Check after asynchronous body parsing, with no await before insertion.
      if (this.clients.size >= MAX_REGISTERED_CLIENTS) {
        json(res, 429, {
          error: "too_many_clients",
          error_description: "OAuth client registration limit reached. Existing connections are preserved; ask the local owner to review unused registrations. Do not delete the OAuth state file."
        });
        return;
      }
      this.clients.set(client.client_id, client);
      await this.persistSnapshot();

      json(res, 201, client as unknown as JsonObject);
    } catch (error) {
      json(res, 400, {
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleAuthorizeGet(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const clientId = query.get("client_id") || "";
    const redirectUri = query.get("redirect_uri") || "";
    const responseType = query.get("response_type") || "";
    const codeChallenge = query.get("code_challenge") || "";
    const codeChallengeMethod = query.get("code_challenge_method") || "";
    const state = query.get("state") || undefined;
    const resource = query.get("resource") || "";
    const scopeRaw = query.get("scope") || undefined;

    const client = this.clients.get(clientId);
    if (!client) {
      html(res, 400, errorPage("Unknown OAuth client. Reconnect the MCP server so ChatGPT can register again."));
      return;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      html(res, 400, errorPage("redirect_uri is not registered for this OAuth client."));
      return;
    }
    // Metered before any approval code is printed or persisted. A flood is answered locally, not
    // redirected, so it cannot be bounced through the registered client either.
    if (this.authorizeTimestamps.length >= AUTHORIZE_REQUESTS_PER_MINUTE) {
      res.setHeader("retry-after", "60");
      html(res, 429, errorPage("Too many authorization requests. Wait a minute and start the OAuth flow again."));
      return;
    }
    this.authorizeTimestamps.push(Date.now());

    try {
      if (responseType !== "code") throw new Error("response_type must be code");
      if (codeChallengeMethod !== "S256") throw new Error("PKCE code_challenge_method must be S256");
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
        throw new Error("invalid PKCE code_challenge");
      }
      if (resource !== this.resource) {
        throw new Error(`resource must exactly equal ${this.resource}`);
      }
      const scope = normalizeScope(scopeRaw);

      const requestId = randomToken(24);
      const approvalCodeRaw = randomBytes(9).toString("base64url").toUpperCase();
      const approvalCode = `${approvalCodeRaw.slice(0, 4)}-${approvalCodeRaw.slice(4, 8)}-${approvalCodeRaw.slice(8)}`;
      const pending: PendingAuthorization = {
        requestId,
        clientId,
        redirectUri,
        ...(state ? { state } : {}),
        resource,
        scope,
        codeChallenge,
        approvalHash: sha256Hex(approvalCode.replaceAll("-", "").toUpperCase()),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + this.config.auth.approvalCodeTtlSec * 1000,
        attempts: 0
      };
      this.evictOldest(this.pending, MAX_PENDING_AUTHORIZATIONS - 1, (value) => value.expiresAtMs);
      this.pending.set(requestId, pending);
      await this.persistSnapshot();

      console.log("");
      console.log("============================================================");
      console.log("[oauth] ChatGPT authorization requested");
      console.log(`[oauth] Client: ${client.client_name || client.client_id}`);
      console.log(`[oauth] Request ID: ${requestId}`);
      console.log(`[oauth] Resource: ${resource}`);
      console.log(`[oauth] Approval code: ${approvalCode}`);
      console.log(`[oauth] Expires in: ${this.config.auth.approvalCodeTtlSec}s`);
      console.log("============================================================");
      console.log("");

      html(
        res,
        200,
        authorizationPage({
          requestId,
          clientName: client.client_name || "ChatGPT MCP client",
          scope: pending.scope,
          resource
        }),
        [new URL(redirectUri).origin]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const location = buildRedirect(redirectUri, {
        error: "invalid_request",
        error_description: message,
        ...(state ? { state } : {}),
        iss: this.issuer
      });
      res.statusCode = 302;
      res.setHeader("location", location);
      res.setHeader("cache-control", "no-store");
      res.end();
    }
  }

  private async handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch (error) {
      html(res, 400, errorPage(error instanceof Error ? error.message : String(error)));
      return;
    }

    const requestId = form.get("request_id") || "";
    const pending = this.pending.get(requestId);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      if (pending) {
        this.pending.delete(requestId);
        await this.persistSnapshot();
      }
      html(res, 400, errorPage("Authorization request expired. Return to ChatGPT and try again."));
      return;
    }

    if (form.get("action") === "deny") {
      this.pending.delete(requestId);
      await this.persistSnapshot();
      const location = buildRedirect(pending.redirectUri, {
        error: "access_denied",
        error_description: "The local owner denied access.",
        ...(pending.state ? { state: pending.state } : {}),
        iss: this.issuer
      });
      res.statusCode = 302;
      res.setHeader("location", location);
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }

    const approvalCode = (form.get("approval_code") || "").replace(/[\s-]/g, "").toUpperCase();
    const approvalHash = sha256Hex(approvalCode);
    pending.attempts += 1;

    if (!safeEqualText(approvalHash, pending.approvalHash)) {
      if (pending.attempts >= 5) {
        this.pending.delete(requestId);
        await this.persistSnapshot();
        html(res, 403, errorPage("Too many incorrect approval-code attempts. Start the OAuth flow again."));
        return;
      }

      await this.persistSnapshot();
      const client = this.clients.get(pending.clientId);
      html(
        res,
        403,
        authorizationPage({
          requestId,
          clientName: client?.client_name || "ChatGPT MCP client",
          scope: pending.scope,
          resource: pending.resource,
          error: "Approval code did not match. Check the local terminal and try again."
        }),
        [new URL(pending.redirectUri).origin]
      );
      return;
    }

    this.pending.delete(requestId);
    const code = randomToken(32);
    this.authorizationCodes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      scope: pending.scope,
      codeChallenge: pending.codeChallenge,
      expiresAtMs: Date.now() + this.config.auth.authorizationCodeTtlSec * 1000
    });
    await this.persistSnapshot();

    const location = buildRedirect(pending.redirectUri, {
      code,
      ...(pending.state ? { state: pending.state } : {}),
      iss: this.issuer
    });
    console.log(`[oauth] Approval accepted - redirecting browser to ${new URL(pending.redirectUri).origin}`);
    res.statusCode = 302;
    res.setHeader("location", location);
    res.setHeader("cache-control", "no-store");
    res.end();
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch (error) {
      json(res, 400, {
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const grantType = form.get("grant_type") || "";
    if (grantType === "authorization_code") {
      await this.exchangeAuthorizationCode(form, res);
      return;
    }
    if (grantType === "refresh_token") {
      await this.exchangeRefreshToken(form, res);
      return;
    }

    json(res, 400, {
      error: "unsupported_grant_type",
      error_description: "Only authorization_code and refresh_token are supported"
    });
  }

  private async exchangeAuthorizationCode(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const code = form.get("code") || "";
    const clientId = form.get("client_id") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const codeVerifier = form.get("code_verifier") || "";
    const resource = form.get("resource") || "";

    const record = this.authorizationCodes.get(code);
    if (!record) {
      json(res, 400, { error: "invalid_grant", error_description: "Unknown or already-used authorization code" });
      return;
    }

    this.authorizationCodes.delete(code);
    await this.persistSnapshot();

    if (record.expiresAtMs <= Date.now()) {
      json(res, 400, { error: "invalid_grant", error_description: "Authorization code expired" });
      return;
    }
    if (clientId !== record.clientId || redirectUri !== record.redirectUri) {
      json(res, 400, { error: "invalid_grant", error_description: "Authorization code binding mismatch" });
      return;
    }
    if (resource !== record.resource || resource !== this.resource) {
      json(res, 400, { error: "invalid_target", error_description: "resource mismatch" });
      return;
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      json(res, 400, { error: "invalid_grant", error_description: "Invalid PKCE code_verifier" });
      return;
    }
    if (!safeEqualText(sha256Base64url(codeVerifier), record.codeChallenge)) {
      json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    console.log("[oauth] Authorization code exchanged for access token");
    const tokens = this.issueTokens(record.clientId, record.scope);
    await this.persistSnapshot();
    json(res, 200, tokens);
  }

  // Refresh tokens rotate: each use retires the presented jti and issues a successor in the same family.
  // A retired jti presented again means the token leaked or was replayed, so the family is revoked.
  private async exchangeRefreshToken(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const refreshToken = form.get("refresh_token") || "";
    const clientId = form.get("client_id") || "";
    const resource = form.get("resource") || this.resource;

    try {
      const payload = this.verifyJwt(refreshToken, "refresh");
      if (payload.client_id !== clientId) throw new Error("refresh token client mismatch");
      if (resource !== this.resource) throw new Error("resource mismatch");
      const active = this.refreshTokens.get(payload.jti);
      if (!active || active.clientId !== clientId) {
        const family = active?.familyId ?? payload.fam;
        if (typeof family === "string") this.revokeRefreshFamily(family);
        await this.persistSnapshot();
        throw new Error("refresh token already used or revoked; authorize again");
      }
      this.refreshTokens.delete(payload.jti);
      const tokens = this.issueTokens(clientId, payload.scope, active.familyId);
      await this.persistSnapshot();
      json(res, 200, tokens);
    } catch (error) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function getBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
