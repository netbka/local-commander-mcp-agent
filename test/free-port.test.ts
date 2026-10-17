import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { freeConfiguredPort, resolveConfiguredPort, resolveConfiguredHost } from "../scripts/free-port.mjs";

async function listenEphemeral(host = "127.0.0.1"): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.end("owned\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  return server;
}

function serverPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose a TCP port");
  }
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readFromPort(port: number, host = "127.0.0.1"): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.once("end", () => resolve(data));
  });
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("freeConfiguredPort rejects an occupied configured port without killing its owner", async () => {
  const server = await listenEphemeral();
  const port = serverPort(server);

  try {
    await withEnv(
      {
        LCMCP_PORT: String(port),
        LCMCP_HOST: "127.0.0.1",
        LCMCP_KILL_PORT_OWNER: "true"
      },
      async () => {
        await assert.rejects(
          () => freeConfiguredPort(),
          /already in use|will not terminate other processes/i
        );
      }
    );

    assert.equal(await readFromPort(port), "owned\n");
  } finally {
    await closeServer(server);
  }
});

async function spawnHolder(dir: string, relativeScript: string): Promise<{ child: ChildProcess; port: number }> {
  const script = path.join(dir, relativeScript);
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, 'const s=require("net").createServer(c=>c.end("held\\n"));s.listen(0,"127.0.0.1",()=>console.log(s.address().port));');
  const child = spawn(process.execPath, [relativeScript], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
  return { child, port };
}

test("freeConfiguredPort preserves unrelated servers with Local Commander entrypoint names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lc-free-port-"));
  const holders: ChildProcess[] = [];
  try {
    for (const script of [path.join("dist", "index.js"), path.join("src", "index.ts"), "other-service.js"]) {
      const holder = await spawnHolder(dir, script);
      holders.push(holder.child);
      await withEnv({ LCMCP_PORT: String(holder.port), LCMCP_HOST: "127.0.0.1", LCMCP_KILL_PORT_OWNER: undefined },
        async () => { await assert.rejects(() => freeConfiguredPort(), /already in use/); });
      assert.equal(holder.child.exitCode, null, script + " must remain alive");
      assert.equal(await readFromPort(holder.port), "held\n");
    }
  } finally {
    for (const child of holders) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("freeConfiguredPort succeeds for an available ephemeral port", async () => {
  const server = await listenEphemeral();
  const port = serverPort(server);
  await closeServer(server);

  await withEnv(
    {
      LCMCP_PORT: String(port),
      LCMCP_HOST: "127.0.0.1",
      LCMCP_KILL_PORT_OWNER: undefined
    },
    async () => {
      await freeConfiguredPort();
    }
  );
});

test("explicit environment port must be strict decimal 1..65535", async () => {
  await withEnv(
    {
      LCMCP_PORT: "123abc",
      LCMCP_HOST: "127.0.0.1",
      LCMCP_KILL_PORT_OWNER: undefined
    },
    async () => {
      assert.throws(() => resolveConfiguredPort(), /strict decimal TCP port/i);
      await assert.rejects(() => freeConfiguredPort(), /strict decimal TCP port/i);
    }
  );

  await withEnv(
    {
      LCMCP_PORT: "0",
      LCMCP_HOST: "127.0.0.1",
      LCMCP_KILL_PORT_OWNER: undefined
    },
    async () => {
      assert.throws(() => resolveConfiguredPort(), /range 1\.\.65535/i);
    }
  );

  await withEnv(
    {
      LCMCP_PORT: "65536",
      LCMCP_HOST: "127.0.0.1",
      LCMCP_KILL_PORT_OWNER: undefined
    },
    async () => {
      assert.throws(() => resolveConfiguredPort(), /range 1\.\.65535/i);
    }
  );
});

test("LCMCP_KILL_PORT_OWNER=false preserves compatibility by skipping the probe", async () => {
  const server = await listenEphemeral();
  const port = serverPort(server);

  try {
    await withEnv(
      {
        LCMCP_PORT: String(port),
        LCMCP_HOST: "127.0.0.1",
        LCMCP_KILL_PORT_OWNER: "false"
      },
      async () => {
        await freeConfiguredPort();
      }
    );

    assert.equal(await readFromPort(port), "owned\n");
  } finally {
    await closeServer(server);
  }
});

test("environment port override preserves configured host and empty explicit ports fail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-endpoint-test-"));
  const file = path.join(root, "settings.json");
  try {
    await writeFile(file, JSON.stringify({ server: { host: "::1", port: 12345 } }));
    await withEnv({ LCMCP_CONFIG: file, LCMCP_HOST: undefined, LCMCP_PORT: "43210" }, () => {
      assert.equal(resolveConfiguredHost(), "::1");
      assert.equal(resolveConfiguredPort(), 43210);
    });
    for (const port of ["", "  ", "1e3", "0x50", "10.5"]) await withEnv({ LCMCP_CONFIG: file, LCMCP_PORT: port }, () => {
      assert.throws(() => resolveConfiguredPort(), /strict decimal/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
