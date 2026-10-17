import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig accepts UTF-8 BOM in JSON config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-config-bom-"));
  const configPath = path.join(root, "local-commander.config.json");
  const previousConfig = process.env.LCMCP_CONFIG;
  const previousRoots = process.env.LCMCP_ROOTS;
  const previousAuth = process.env.LCMCP_AUTH_MODE;

  try {
    const body = JSON.stringify({
      roots: [root],
      auth: { mode: "none" }
    });
    await writeFile(configPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(body, "utf8")
    ]));

    process.env.LCMCP_CONFIG = configPath;
    delete process.env.LCMCP_ROOTS;
    delete process.env.LCMCP_AUTH_MODE;

    const config = loadConfig();
    assert.deepEqual(config.roots, [root]);
    assert.equal(config.auth.mode, "none");
  } finally {
    if (previousConfig === undefined) delete process.env.LCMCP_CONFIG;
    else process.env.LCMCP_CONFIG = previousConfig;
    if (previousRoots === undefined) delete process.env.LCMCP_ROOTS;
    else process.env.LCMCP_ROOTS = previousRoots;
    if (previousAuth === undefined) delete process.env.LCMCP_AUTH_MODE;
    else process.env.LCMCP_AUTH_MODE = previousAuth;
    await rm(root, { recursive: true, force: true });
  }
});
