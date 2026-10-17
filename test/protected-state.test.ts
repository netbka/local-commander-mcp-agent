import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuard } from "../src/guard.js";

async function withTempRoot(fn: (root: string, parent: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lcmcp-protected-"));
  const root = path.join(parent, "root");
  await mkdir(root);
  try {
    await fn(root, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function makeDirectoryAlias(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("PathGuard blocks Local Commander protected state by default", async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, ".local-commander-oauth.json"), "{}");
    await writeFile(path.join(root, ".local-commander-audit.jsonl"), "event\n");
    await writeFile(path.join(root, ".local-commander-audit.jsonl.1"), "event\n");
    await writeFile(path.join(root, "local-commander.config.json"), "{}");
    await mkdir(path.join(root, ".local-commander"));
    await writeFile(path.join(root, ".local-commander", "state.json"), "{}");

    const guard = await PathGuard.create([root], false);

    await assert.rejects(
      () => guard.resolveExisting(".local-commander-oauth.json"),
      /protected state/i
    );
    await assert.rejects(
      () => guard.resolveExisting(".local-commander-audit.jsonl"),
      /protected state/i
    );
    await assert.rejects(
      () => guard.resolveExisting(".local-commander-audit.jsonl.1"),
      /protected state/i
    );
    await assert.rejects(
      () => guard.resolveExisting("local-commander.config.json"),
      /protected state/i
    );
    await assert.rejects(
      () => guard.resolveExisting(path.join(".local-commander", "state.json")),
      /protected state/i
    );
    await assert.rejects(
      () => guard.resolveForWrite(path.join(".local-commander", "new.json")),
      /protected state/i
    );
  });
});

test("PathGuard blocks agent state even when sensitive files are allowed", async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, ".local-commander-oauth.json"), "{}");
    await writeFile(path.join(root, ".env"), "SECRET=x");

    const guard = await PathGuard.create([root], true);

    assert.equal(await guard.resolveExisting(".env"), path.join(root, ".env"));
    assert.doesNotThrow(() => guard.assertSafeFile(path.join(root, ".env")));
    await assert.rejects(
      () => guard.resolveExisting(".local-commander-oauth.json"),
      /protected state/i
    );
    assert.throws(
      () => guard.assertSafeFile(path.join(root, ".local-commander-oauth.json")),
      /protected state/i
    );
  });
});

test("PathGuard custom protected paths deny existing and future subtree targets", async () => {
  await withTempRoot(async (root) => {
    const protectedDir = path.join(root, "private");
    await mkdir(protectedDir);
    await writeFile(path.join(protectedDir, "secret.txt"), "secret");
    await writeFile(path.join(root, "public.txt"), "public");

    const guard = await PathGuard.create([root], false, {
      protectedPaths: [protectedDir, path.join(root, "future", "state.json")]
    });

    await assert.rejects(() => guard.resolveExisting(path.join("private", "secret.txt")), /Protected path/);
    await assert.rejects(() => guard.resolveForWrite(path.join("private", "new.txt")), /Protected path/);
    await mkdir(path.join(root, "future"));
    await assert.rejects(() => guard.resolveForWrite(path.join("future", "state.json")), /Protected path/);
    assert.equal(await guard.resolveExisting("public.txt"), path.join(root, "public.txt"));
  });
});

test("PathGuard denies protected directory aliases", async () => {
  await withTempRoot(async (root) => {
    const protectedDir = path.join(root, "protected-real");
    const aliasDir = path.join(root, "alias");
    await mkdir(protectedDir);
    await writeFile(path.join(protectedDir, "state.txt"), "secret");
    await makeDirectoryAlias(protectedDir, aliasDir);

    const guard = await PathGuard.create([root], false, { protectedPaths: [protectedDir] });

    await assert.rejects(() => guard.resolveExisting(path.join("alias", "state.txt")), /Protected path/);
    await assert.rejects(() => guard.resolveForWrite(path.join("alias", "new.txt")), /Protected path/);
  });
});

test("PathGuard rejects aliases that resolve outside configured roots", async () => {
  await withTempRoot(async (root, parent) => {
    const outsideDir = path.join(parent, "outside");
    const aliasDir = path.join(root, "outside-alias");
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, "outside.txt"), "outside");
    await makeDirectoryAlias(outsideDir, aliasDir);

    const guard = await PathGuard.create([root], false);

    await assert.rejects(
      () => guard.resolveExisting(path.join("outside-alias", "outside.txt")),
      /outside configured roots/
    );
  });
});

test("PathGuard permits ordinary files and names that only resemble parent traversal", async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, "ordinary.txt"), "ok");
    await writeFile(path.join(root, "..notes"), "ok");
    await writeFile(path.join(root, ".env.example"), "EXAMPLE=x");
    await writeFile(path.join(root, "local-commander.config.example.json"), "{}");

    const guard = await PathGuard.create([root], false);

    assert.equal(await guard.resolveExisting("ordinary.txt"), path.join(root, "ordinary.txt"));
    assert.equal(await guard.resolveExisting("..notes"), path.join(root, "..notes"));
    assert.equal(await guard.resolveExisting(".env.example"), path.join(root, ".env.example"));
    assert.equal(
      await guard.resolveForWrite("local-commander.config.example.json"),
      path.join(root, "local-commander.config.example.json")
    );
    assert.equal(guard.isWithin(path.join(root, "..notes"), root), true);
  });
});

test("PathGuard resolveForWrite fails closed for dangling symlinks", async (t) => {

  await withTempRoot(async (root) => {
    const link = path.join(root, "dangling-link");
    try { await symlink(path.join(root, "missing-target"), link, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("OS denied synthetic link creation"); return; }
      throw error;
    }
    const stat = await lstat(link);
    assert.equal(stat.isSymbolicLink(), true);

    const guard = await PathGuard.create([root], false);
    await assert.rejects(() => guard.resolveForWrite("dangling-link"));
  });
});
