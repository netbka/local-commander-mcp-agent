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
  content: string | Uint8Array,
  options: { overwrite: boolean; expected?: ExpectedFile }
): Promise<void> {
  if ((await guard.resolveForWrite(target)) !== target) throw new Error("FILE_CHANGED");
  const temporary = path.join(path.dirname(target), `.lc-write-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    try { await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined); await handle.datasync(); } finally { await handle.close(); }
    if ((await guard.resolveForWrite(target)) !== target) throw new Error("FILE_CHANGED");
    if (options.overwrite) await replaceWithRetry(temporary, target, options.expected);
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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Antivirus scanners and indexers hold a file briefly; an editor or a read-only attribute does not let go.
// About 0.75 s of retries on Windows, re-checking the target each time, then a named failure.
async function replaceWithRetry(temporary: string, target: string, expected: ExpectedFile | undefined): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await assertReplaceable(target, expected);
    try { await rename(temporary, target); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (attempt === 4) {
        if ((await lstat(target)).mode & 0o200) throw new Error(`FILE_IN_USE: another program has ${target} open, so it was not changed`);
        throw new Error(`FILE_READ_ONLY: ${target} is read-only, so it was not changed`);
      }
      await delay(50 << attempt);
    }
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
