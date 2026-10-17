import { randomBytes } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { PathGuard } from "./guard.js";

export interface ExpectedFile { size: number; modifiedAt: string }

// Commit text without following a path swapped after validation: the bytes go to an
// exclusive temporary sibling, the guard re-validates the target, then a single
// rename (replace) or link (create-only, never clobbers) publishes the finished file.
export async function commitTextFile(
  guard: PathGuard,
  target: string,
  content: string,
  options: { overwrite: boolean; expected?: ExpectedFile }
): Promise<void> {
  if ((await guard.resolveForWrite(target)) !== target) throw new Error("FILE_CHANGED");
  const temporary = path.join(path.dirname(target), `.lc-write-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    try { await handle.writeFile(content, "utf8"); await handle.datasync(); } finally { await handle.close(); }
    if ((await guard.resolveForWrite(target)) !== target) throw new Error("FILE_CHANGED");
    if (options.overwrite) await assertReplaceable(target, options.expected);
    if (options.overwrite) await rename(temporary, target);
    else {
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`File already exists: ${target}`);
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertReplaceable(target: string, expected: ExpectedFile | undefined): Promise<void> {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected) return;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Not a regular file: ${target}`);
  // A hard link would make a rename detach this name from other names, or (before) write through to a file outside the roots.
  if (info.nlink > 1) throw new Error(`Refusing to write a hard-linked file: ${target}`);
  if (expected && (info.size !== expected.size || Math.abs(info.mtimeMs - Date.parse(expected.modifiedAt)) > 2)) {
    throw new Error("FILE_CHANGED");
  }
}
