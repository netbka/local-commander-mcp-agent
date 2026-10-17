import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { AuditLogger } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import { readFilePrefix } from "../src/file-read.js";
import { PathGuard } from "../src/guard.js";
import type { ProcessManager } from "../src/process.js";
import { ExecutionScheduler } from "../src/scheduler.js";
import { registerTools } from "../src/tools.js";

test("personal file readers preserve bounded content and deny Windows parent replacement", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lc-personal-read-"));
  const root = path.join(temporary, "root"), outside = path.join(temporary, "outside");
  await mkdir(root); await mkdir(outside);
  try {
    const guard = await PathGuard.create([root], false);
    type Reply = { isError?: boolean; content: { text: string }[] };
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Reply>>();
    const server = { registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<Reply>) { handlers.set(name, handler); } };
    const config = { auth: { mode: "none" }, files: { maxReadBytes: 16, maxWriteBytes: 64, maxSearchFileBytes: 64, allowSensitiveFiles: false }, shell: { maxTimeoutMs: 240_000 } } as AppConfig;
    registerTools(server as unknown as McpServer, config, guard, {} as ProcessManager, new AuditLogger({ mode: "off" }), new ExecutionScheduler());
    const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

    await t.test("same-handle metadata, large previews, ranges, empty and binary content", async () => {
      const file = path.join(root, "note.txt"), fixed = new Date("2024-01-01T00:00:00Z");
      await writeFile(file, "first\r\nsecond\nlast"); await utimes(file, fixed, fixed);
      const read = await readFilePrefix(guard, file, 16);
      assert.equal(read.path, await realpath(file)); assert.equal(read.size, (await stat(file)).size);
      assert.equal(read.modifiedAt, fixed.toISOString()); assert.equal(read.truncated, true);
      assert.equal(read.data.toString(), "first\r\nsecond\nla");
      const ranged = await call("fs_read", { path: file, startLine: 2, endLine: 2 });
      assert.notEqual(ranged.isError, true);
      assert.deepEqual(JSON.parse(ranged.content[0]!.text), { path: read.path, size: 18, modifiedAt: fixed.toISOString(), startLine: 2, endLine: 2, content: "second", truncated: true });
      await writeFile(file, Buffer.alloc(1049000, 65));
      const prefix = await readFilePrefix(guard, file, 9);
      assert.equal(prefix.data.toString(), "AAAAAAAAA"); assert.equal(prefix.size, 1049000); assert.equal(prefix.truncated, true);
      assert.equal((await call("fs_replace", { path: file, oldText: "A", newText: "B", replaceAll: true })).isError, true);
      await writeFile(file, "");
      assert.equal((await readFilePrefix(guard, file, 1)).data.length, 0);
      assert.equal(JSON.parse((await call("fs_read", { path: file })).content[0]!.text).content, "");
      await writeFile(file, Buffer.from([0, 1, 255]));
      assert.equal((await call("fs_read", { path: file })).isError, true);
      await assert.rejects(readFilePrefix(guard, file, 16777217), /FILE_READ_LIMIT_INVALID/);
      await writeFile(path.join(root, ".env"), "SYNTHETIC=private");
      await assert.rejects(readFilePrefix(guard, ".env", 64), /Sensitive file access/);
    });

    await t.test("replacement and search use fresh bounded content", async () => {
      const file = path.join(root, "note.txt"), fixed = new Date("2024-01-01T00:00:00Z");
      await writeFile(file, "AAAA"); await utimes(file, fixed, fixed);
      assert.equal((await readFilePrefix(guard, file, 16)).data.toString(), "AAAA");
      await writeFile(file, "BBBB"); await utimes(file, fixed, fixed);
      assert.equal((await readFilePrefix(guard, file, 16)).data.toString(), "BBBB");
      assert.notEqual((await call("fs_replace", { path: file, oldText: "BBBB", newText: "updated", replaceAll: false })).isError, true);
      const search = await call("fs_search", { path: root, query: "updated", regex: false, caseSensitive: true, maxResults: 10 });
      assert.notEqual(search.isError, true); assert.equal(JSON.parse(search.content[0]!.text).results[0].text, "updated");
      config.files.maxSearchFileBytes = 16777217;
      try { assert.equal((await call("fs_search", { path: root, query: "updated", maxResults: 10 })).isError, true); }
      finally { config.files.maxSearchFileBytes = 64; }
    });

    await t.test("exact replacement preserves literal dollar tokens in both modes", async () => {
      const file = path.join(root, "literal.txt");
      const newText = "$$ $& $` $' $1";
      for (const replaceAll of [false, true]) {
        await writeFile(file, replaceAll ? "pre|needle|needle|post" : "pre|needle|post");
        const reply = await call("fs_replace", { path: file, oldText: "needle", newText, replaceAll });
        assert.notEqual(reply.isError, true);
        assert.equal(JSON.parse(reply.content[0]!.text).replacements, replaceAll ? 2 : 1);
        assert.equal(await readFile(file, "utf8"), replaceAll ? "pre|$$ $& $` $' $1|$$ $& $` $' $1|post" : "pre|$$ $& $` $' $1|post");
      }
      await writeFile(file, "needle|needle");
      for (const oldText of ["needle", "missing"]) {
        assert.equal((await call("fs_replace", { path: file, oldText, newText, replaceAll: false })).isError, true);
        assert.equal(await readFile(file, "utf8"), "needle|needle");
      }
    });

    await t.test("each personal content reader refuses a junction swapped after its path check", { skip: process.platform !== "win32" }, async () => {
      await writeFile(path.join(outside, "note.txt"), "OUTSIDE-PRIVATE-FIXTURE");
      for (const operation of ["prefix", "fs_read", "fs_search", "fs_replace"]) {
        const directory = path.join(root, operation), saved = directory + "-saved";
        await mkdir(directory); await writeFile(path.join(directory, "note.txt"), "inside");
        const canonical = await realpath(path.join(directory, "note.txt"));
        const original = guard.resolveExisting.bind(guard);
        let swapped = false;
        const mocked = t.mock.method(guard, "resolveExisting", async (...args: Parameters<typeof original>) => {
          const resolved = await original(...args);
          if (!swapped && resolved === canonical) {
            await rename(directory, saved); await symlink(outside, directory, "junction"); swapped = true;
          }
          return resolved;
        });
        try {
          if (operation === "prefix") await assert.rejects(readFilePrefix(guard, canonical, 64), /^Error: FILE_CHANGED$/);
          else {
            const reply = await call(operation, { path: operation === "fs_search" ? directory : canonical, query: "OUTSIDE", regex: false, caseSensitive: true, maxResults: 10, oldText: "OUTSIDE", newText: "changed", replaceAll: true });
            assert(!JSON.stringify(reply).includes("OUTSIDE-PRIVATE-FIXTURE"));
            if (operation === "fs_search") assert.deepEqual(JSON.parse(reply.content[0]!.text).results, []);
            else assert.equal(reply.isError, true);
          }
          assert.equal(swapped, true);
          assert.equal(await readFile(path.join(outside, "note.txt"), "utf8"), "OUTSIDE-PRIVATE-FIXTURE");
        } finally {
          mocked.mock.restore();
          if (swapped) { await unlink(directory); await rename(saved, directory); }
        }
      }
    });
  } finally {
    assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temporary, { recursive: true, force: true });
  }
});
