import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { createNativeHttpBoundary } from "../src/http-boundary.js";

function config(port: number, host = "127.0.0.1", publicBaseUrl = "https://public.example.test"): Pick<AppConfig, "server" | "auth"> {
  return { server: { host, port, mcpPath: "/mcp" }, auth: {
    mode: "bearer", publicBaseUrl, oauthStatePath: "unused", accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 3600, authorizationCodeTtlSec: 300, approvalCodeTtlSec: 300
  } };
}

test("native HTTP boundary checks real Host/Origin headers before handling", async (t) => {
  let handled = 0;
  let guard: ReturnType<typeof createNativeHttpBoundary>;
  const server = createServer((req, res) => {
    if (!guard(req, res)) return;
    handled += 1;
    res.end("allowed");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  guard = createNativeHttpBoundary(config(port));
  const local = `127.0.0.1:${port}`;
  const cases: Array<[string, string[], number]> = [
    ["non-browser request has no Origin", ["Host", local], 200],
    ["exact local origin", ["Host", local, "Origin", `http://${local}`], 200],
    ["localhost alias", ["Host", `localhost:${port}`, "Origin", `http://localhost:${port}`], 200],
    ["bracketed IPv6 alias", ["Host", `[::1]:${port}`, "Origin", `http://[::1]:${port}`], 200],
    ["configured public tunnel origin with forwarded local Host", ["Host", local, "Origin", "https://public.example.test"], 200],
    ["configured public Host", ["Host", "public.example.test", "Origin", "https://public.example.test"], 200],
    ["invalid Origin denied", ["Host", local, "Origin", "https://untrusted.example"], 403],
    ["hostname suffix is not trusted", ["Host", local, "Origin", "https://public.example.test.untrusted.example"], 403],
    ["opaque Origin denied", ["Host", local, "Origin", "null"], 403],
    ["empty present Origin denied", ["Host", local, "Origin", ""], 403],
    ["malformed Origin denied", ["Host", local, "Origin", "not-an-origin"], 403],
    ["multiple origins denied", ["Host", local, "Origin", `http://${local} https://untrusted.example`], 403],
    ["another localhost service is not same origin", ["Host", local, "Origin", "http://127.0.0.1:1"], 403],
    ["public HTTPS downgrade denied", ["Host", local, "Origin", "http://public.example.test"], 403],
    ["public non-configured port denied", ["Host", local, "Origin", "https://public.example.test:444"], 403],
    ["origin userinfo denied", ["Host", local, "Origin", "https://privatevalue@public.example.test"], 403],
    ["origin path denied", ["Host", local, "Origin", "https://public.example.test/privatevalue"], 403],
    ["origin query denied", ["Host", local, "Origin", "https://public.example.test?privatevalue"], 403],
    ["origin fragment denied", ["Host", local, "Origin", "https://public.example.test#privatevalue"], 403],
    ["empty query delimiter is not an origin", ["Host", local, "Origin", "https://public.example.test?"], 403],
    ["empty fragment delimiter is not an origin", ["Host", local, "Origin", "https://public.example.test#"], 403],
    ["non-web scheme denied", ["Host", local, "Origin", "file://public.example.test"], 403],
    ["duplicate Origin denied", ["Host", local, "Origin", `http://${local}`, "oRiGiN", `http://${local}`], 403],
    ["duplicate Host denied", ["Host", local, "hOsT", local], 403],
    ["untrusted Host denied", ["Host", "untrusted.example", "Origin", `http://${local}`], 403],
    ["Host userinfo denied", ["Host", `privatevalue@${local}`], 403],
    ["Host path denied", ["Host", `${local}/privatevalue`], 403],
    ["Forwarded cannot authorize a Host", ["Host", "untrusted.example", "Forwarded", "host=public.example.test", "X-Forwarded-Host", "public.example.test"], 403],
    ["Forwarded cannot authorize an Origin", ["Host", local, "Origin", "https://untrusted.example", "X-Forwarded-Proto", "https", "X-Forwarded-Host", "public.example.test"], 403]
  ];
  try {
    for (const [name, headers, status] of cases) await t.test(name, async () => {
      const before = handled;
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", headers, setHost: false, agent: false }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (s: string) => body += s);
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.setTimeout(2000, () => req.destroy(new Error("TEST_TIMEOUT")));
        req.on("error", reject);
        req.end();
      });
      assert.equal(result.status, status, name);
      assert.equal(handled - before, status === 200 ? 1 : 0, "rejected requests never reach handlers");
      assert.ok(!result.body.includes("privatevalue"), "response never reflects untrusted header contents");
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("boundary configuration rejects invalid public origins and ignores wildcard binds", () => {
  for (const url of ["http://public.example.test", "https://user:secret@public.example.test", "https://public.example.test/path", "not-a-url"]) {
    assert.throws(() => createNativeHttpBoundary(config(17321, "127.0.0.1", url)), /INVALID_PUBLIC_HTTP_ORIGIN/);
  }
  for (const port of [0, -1, 65536, 1.5]) assert.throws(() => createNativeHttpBoundary(config(port)), /INVALID_HTTP_PORT/);
  for (const host of ["0.0.0.0", "::", "[::]"]) assert.doesNotThrow(() => createNativeHttpBoundary(config(17321, host)));
});

test("missing Host fails closed even before framework routing", () => {
  const guard = createNativeHttpBoundary(config(17321));
  let status = 0;
  const res = { writeHead(s: number) { status = s; }, end() {} } as unknown as ServerResponse;
  assert.equal(guard({ rawHeaders: [], headers: {} } as unknown as IncomingMessage, res), false);
  assert.equal(status, 403);
});
