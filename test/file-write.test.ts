import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { AuditLogger } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import { PathGuard } from "../src/guard.js";
import type { ProcessManager } from "../src/process.js";
import { ExecutionScheduler } from "../src/scheduler.js";
import { registerTools } from "../src/tools.js";

test("personal writes commit atomically and refuse raced or aliased targets", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-write-commit-"));
  const root = path.join(temporary, "root"), outside = path.join(temporary, "outside");
  await mkdir(root); await mkdir(outside);
  try {
    const guard = await PathGuard.create([root], false);
    type Reply = { isError?: boolean; content: { text: string }[] };
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Reply>>();
    const server = { registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<Reply>) { handlers.set(name, handler); } };
    const config = { auth: { mode: "none" }, files: { maxReadBytes: 1024, maxWriteBytes: 1024, maxSearchFileBytes: 1024, allowSensitiveFiles: false }, shell: { maxTimeoutMs: 240_000 } } as AppConfig;
    registerTools(server as unknown as McpServer, config, guard, {} as ProcessManager, new AuditLogger({ mode: "off" }), new ExecutionScheduler());
    const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
    const leftovers = async (directory: string) => (await readdir(directory)).filter((name) => name.startsWith(".lc-write-"));

    await t.test("create-only never clobbers and overwrite replaces whole content without temp leftovers", async () => {
      const file = path.join(root, "a.txt");
      assert.notEqual((await call("fs_write", { path: file, content: "one", overwrite: false })).isError, true);
      assert.equal((await call("fs_write", { path: file, content: "two", overwrite: false })).isError, true);
      assert.equal(await readFile(file, "utf8"), "one");
      assert.notEqual((await call("fs_write", { path: file, content: "three", overwrite: true })).isError, true);
      assert.equal(await readFile(file, "utf8"), "three");
      assert.deepEqual(await leftovers(root), []);
    });

    await t.test("fs_replace refuses a file modified by another process after it was read", async () => {
      const file = path.join(root, "b.txt");
      await writeFile(file, "alpha beta");
      const original = guard.resolveForWrite.bind(guard);
      const mocked = t.mock.method(guard, "resolveForWrite", async (...args: Parameters<typeof original>) => {
        await writeFile(file, "alpha beta EXTERNAL EDIT");
        return original(...args);
      });
      try {
        const reply = await call("fs_replace", { path: file, oldText: "beta", newText: "gamma" });
        assert.equal(reply.isError, true); assert.match(reply.content[0]!.text, /FILE_CHANGED/);
      } finally { mocked.mock.restore(); }
      assert.equal(await readFile(file, "utf8"), "alpha beta EXTERNAL EDIT");
      assert.deepEqual(await leftovers(root), []);
    });

    await t.test("hard-linked files are not written through", async () => {
      const file = path.join(root, "c.txt"), alias = path.join(root, "c-alias.txt");
      await writeFile(file, "linked"); await link(file, alias);
      for (const name of ["fs_write", "fs_replace"]) {
        const reply = await call(name, { path: alias, content: "changed", overwrite: true, oldText: "linked", newText: "changed" });
        assert.equal(reply.isError, true); assert.match(reply.content[0]!.text, /hard-linked/);
      }
      assert.equal(await readFile(file, "utf8"), "linked"); assert.equal(await readFile(alias, "utf8"), "linked");
    });

    await t.test("a parent swapped for a junction after the path check writes nothing outside", { skip: process.platform !== "win32" }, async () => {
      const directory = path.join(root, "swap"), saved = directory + "-saved";
      await mkdir(directory);
      const canonical = path.join(await realpath(directory), "n.txt");
      const original = guard.resolveForWrite.bind(guard);
      let swapped = false;
      const mocked = t.mock.method(guard, "resolveForWrite", async (...args: Parameters<typeof original>) => {
        const resolved = await original(...args);
        if (!swapped && resolved === canonical) { await rename(directory, saved); await symlink(outside, directory, "junction"); swapped = true; }
        return resolved;
      });
      try {
        assert.equal((await call("fs_write", { path: canonical, content: "ESCAPED", overwrite: true })).isError, true);
      } finally { mocked.mock.restore(); }
      assert.deepEqual(await readdir(outside), []);
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
