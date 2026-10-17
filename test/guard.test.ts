import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";

test("PathGuard permits configured root and blocks escape", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lcmcp-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside.txt");
  await mkdir(root);
  await writeFile(path.join(root, "ok.txt"), "ok");
  await writeFile(outside, "no");

  try {
    const guard = await PathGuard.create([root], false);
    assert.equal(await guard.resolveExisting("ok.txt"), path.join(root, "ok.txt"));
    await assert.rejects(() => guard.resolveExisting("../outside.txt"), /outside configured roots/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PathGuard blocks secret-like files by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-secret-"));
  await writeFile(path.join(root, ".env"), "SECRET=x");

  try {
    const guard = await PathGuard.create([root], false);
    const file = await guard.resolveExisting(".env");
    assert.throws(() => guard.assertSafeFile(file), /Sensitive file access is blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PathGuard blocks credential stores identified by their directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcmcp-secret-dirs-"));
  try {
    const guard = await PathGuard.create([root], false);
    for (const relative of [".aws/credentials", ".kube/config", ".docker/config.json", ".claude/.credentials.json", ".codex/auth.json",
      ".ssh/known_hosts", ".ssh/work_key", ".gnupg/private-keys-v1.d/x.key", "AppData/Roaming/GitHub CLI/hosts.yml", "id_ecdsa", "_netrc", "vault.kdbx", "putty.ppk"]) {
      assert.throws(() => guard.assertSafeFile(path.join(root, relative)), /Sensitive file access is blocked/, relative);
    }
    for (const relative of ["config", "project/config.json", "docs/credentials.md", ".aws/config", "notes/auth.json"]) {
      assert.doesNotThrow(() => guard.assertSafeFile(path.join(root, relative)), relative);
    }
    const open = await PathGuard.create([root], true);
    assert.doesNotThrow(() => open.assertSafeFile(path.join(root, ".kube/config")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
