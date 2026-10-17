import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17321;
const PROBE_TIMEOUT_MS = 2000;

function parseStrictPort(value, source) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(
      `${source} must be a strict decimal TCP port in the range 1..65535`
    );
  }

  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${source} must be a strict decimal TCP port in the range 1..65535`
    );
  }

  return port;
}

function readConfig() {
  const configPath = path.resolve(
    process.env.LCMCP_CONFIG?.trim() ||
      path.join(process.cwd(), "local-commander.config.json")
  );

  if (!existsSync(configPath)) return undefined;

  return JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
}

function configuredEndpoint() {

  const config = readConfig();
  const configPort = config?.server?.port;
  const host =
    process.env.LCMCP_HOST?.trim() ||
    (typeof config?.server?.host === "string" && config.server.host.trim()
      ? config.server.host.trim()
      : DEFAULT_HOST);

  if (process.env.LCMCP_PORT !== undefined) {
    return { host, port: parseStrictPort(process.env.LCMCP_PORT, "LCMCP_PORT") };
  }

  if (configPort !== undefined && configPort !== null) {
    return {
      host,
      port: parseStrictPort(configPort, "local-commander.config.json server.port")
    };
  }

  return { host, port: DEFAULT_PORT };
}

export function resolveConfiguredPort() {
  return configuredEndpoint().port;
}

export function resolveConfiguredHost() {
  return configuredEndpoint().host;
}

function shouldSkipProbe() {
  return /^(0|false|no|off)$/i.test(process.env.LCMCP_KILL_PORT_OWNER?.trim() ?? "");
}

async function probeExclusiveBind(host, port) {
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out while checking whether ${host}:${port} is available. Stop the process using that address or configure a different Local Commander host/port.`
        )
      );
    }, PROBE_TIMEOUT_MS);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep error handling attached if DNS/binding completes after timeout.
      if (server.listening) server.close();
      if (error) reject(error);
      else resolve();
    }

    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        finish(
          new Error(
            `Local Commander cannot start because ${host}:${port} is already in use. Stop the process that owns this address or configure a different Local Commander host/port.`
          )
        );
        return;
      }

      finish(error);
    });

    try {
      server.listen({ host, port, exclusive: true }, () => {
        server.close((error) => finish(error ?? undefined));
      });
    } catch (error) { finish(error); }
  });
}

export async function freeConfiguredPort() {
  if (shouldSkipProbe()) {
    console.log("[prestart] existing-port safety probe disabled");
    return;
  }

  const { host, port } = configuredEndpoint();
  await probeExclusiveBind(host, port);
  console.log(`[prestart] ${host}:${port} is available`);
}

function sameEntryPoint(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const isMain =
  process.argv[1] && sameEntryPoint(process.argv[1], fileURLToPath(import.meta.url));

if (isMain) {
  freeConfiguredPort().catch((error) => {
    console.error(
      `[prestart] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
