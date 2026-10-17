import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { PathGuard } from "./guard.js";
import { commitTextFile } from "./file-write.js";
import { parseControllerSnapshot, type ControllerSnapshot } from "./task-controller.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_BYTES = 1024;
const LOCK_VERSION = 1;
type Save = (state: ControllerSnapshot) => Promise<void>;
type LockRecord = { version: 1; pid: number; token: string; acquiredAt: number };
export interface ControllerStore {
  // Serialize the whole supervisor cycle, including effects. save() atomically
  // commits before an effect; the callback receives an isolated working copy.
  exclusive<T>(fn: (state: ControllerSnapshot | undefined, save: Save) => Promise<T>): Promise<T>;
}
function encode(state: ControllerSnapshot): string {
  const text = JSON.stringify(parseControllerSnapshot(state));
  if (Buffer.byteLength(text) > MAX_BYTES) throw Error("CONTROLLER_STORE_LIMIT");
  return text;
}
function decode(text: string): ControllerSnapshot {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw Error();
    return parseControllerSnapshot(JSON.parse(text));
  } catch { throw Error("CONTROLLER_STORE_CORRUPT"); }
}
function lockText(record: LockRecord): string {
  return JSON.stringify(record);
}
function parseLock(text: string): LockRecord | undefined {
  try {
    if (Buffer.byteLength(text) > MAX_LOCK_BYTES) return undefined;
    const value = JSON.parse(text) as Partial<LockRecord>;
    if (value.version !== LOCK_VERSION) return undefined;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || (value.pid ?? 0) > 0x7fffffff) return undefined;
    if (typeof value.token !== "string" || value.token.length < 16 || value.token.length > 80) return undefined;
    if (!Number.isInteger(value.acquiredAt) || (value.acquiredAt ?? 0) <= 0 || (value.acquiredAt ?? 0) > Date.now() + 5 * 60_000) return undefined;
    return value as LockRecord;
  } catch { return undefined; }
}
function sameLock(a: LockRecord, b: LockRecord): boolean {
  return a.pid === b.pid && a.token === b.token && a.acquiredAt === b.acquiredAt;
}
function ownerIsGone(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
async function readLock(path: string): Promise<{ kind: "missing" } | { kind: "unknown" } | { kind: "record"; record: LockRecord }> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unknown" };
  }
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_LOCK_BYTES) return { kind: "unknown" };
    const record = parseLock(await handle.readFile("utf8"));
    return record ? { kind: "record", record } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  } finally {
    await handle.close();
  }
}
async function createOwnedLock(path: string): Promise<{ handle: FileHandle; record: LockRecord }> {
  const handle = await open(path, "wx", 0o600);
  const record: LockRecord = { version: LOCK_VERSION, pid: process.pid, token: randomUUID(), acquiredAt: Date.now() };
  try {
    await handle.writeFile(lockText(record), "utf8");
    await handle.datasync();
    return { handle, record };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}
async function releaseOwnedLock(path: string, owned: { handle: FileHandle; record: LockRecord }): Promise<void> {
  await owned.handle.close();
  const current = await readLock(path);
  if (current.kind !== "record" || !sameLock(current.record, owned.record)) throw Error("CONTROLLER_STORE_IO");
  await unlink(path);
}
export class MemoryControllerStore implements ControllerStore {
  private text: string | undefined;
  private busy = false;
  async exclusive<T>(fn: (state: ControllerSnapshot | undefined, save: Save) => Promise<T>): Promise<T> {
    if (this.busy) throw Error("CONTROLLER_STORE_BUSY");
    this.busy = true;
    try {
      return await fn(this.text === undefined ? undefined : decode(this.text), async state => { this.text = encode(state); });
    } finally { this.busy = false; }
  }
}
export class FileControllerStore implements ControllerStore {
  constructor(private readonly guard: PathGuard, private readonly file: string) {}

  private async acquireRecoveryGate(gatePath: string): Promise<{ handle: FileHandle; record: LockRecord } | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await createOwnedLock(gatePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw Error("CONTROLLER_STORE_IO");
      }
      const existing = await readLock(gatePath);
      if (existing.kind === "missing") continue;
      if (existing.kind !== "record" || !ownerIsGone(existing.record.pid)) return undefined;
      const tombPath = await this.guard.resolveForWrite(gatePath + ".stale." + randomUUID());
      try {
        await rename(gatePath, tombPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return undefined;
      }
      const moved = await readLock(tombPath);
      if (moved.kind !== "record" || !sameLock(moved.record, existing.record)) return undefined;
      await unlink(tombPath).catch(() => {});
    }
    return undefined;
  }

  private async acquireFileLock(lockPath: string): Promise<{ handle: FileHandle; record: LockRecord }> {
    try { return await createOwnedLock(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw Error("CONTROLLER_STORE_IO");
    }

    const gatePath = await this.guard.resolveForWrite(lockPath + ".recovery");
    const gate = await this.acquireRecoveryGate(gatePath);
    if (!gate) throw Error("CONTROLLER_STORE_BUSY");
    try {
      const existing = await readLock(lockPath);
      if (existing.kind === "missing") {
        try { return await createOwnedLock(lockPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("CONTROLLER_STORE_BUSY");
          throw Error("CONTROLLER_STORE_IO");
        }
      }
      if (existing.kind !== "record" || !ownerIsGone(existing.record.pid)) throw Error("CONTROLLER_STORE_BUSY");

      const confirmed = await readLock(lockPath);
      if (confirmed.kind !== "record" || !sameLock(confirmed.record, existing.record)) throw Error("CONTROLLER_STORE_BUSY");
      try { await unlink(lockPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error("CONTROLLER_STORE_BUSY");
        throw Error("CONTROLLER_STORE_IO");
      }
      try { return await createOwnedLock(lockPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("CONTROLLER_STORE_BUSY");
        throw Error("CONTROLLER_STORE_IO");
      }
    } finally {
      await releaseOwnedLock(gatePath, gate).catch(() => {});
    }
  }

  async exclusive<T>(fn: (state: ControllerSnapshot | undefined, save: Save) => Promise<T>): Promise<T> {
    const target = await this.guard.resolveForWrite(this.file);
    const lockPath = await this.guard.resolveForWrite(target + ".lock");
    let lock: { handle: FileHandle; record: LockRecord };
    try { lock = await this.acquireFileLock(lockPath); }
    catch (error) {
      if ((error as Error).message === "CONTROLLER_STORE_BUSY") throw error;
      throw Error("CONTROLLER_STORE_IO");
    }
    try {
      let state: ControllerSnapshot | undefined;
      try {
        const handle = await open(await this.guard.resolveExisting(target), "r");
        try {
          if ((await handle.stat()).size > MAX_BYTES) throw Error("CONTROLLER_STORE_LIMIT");
          state = decode(await handle.readFile("utf8"));
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("CONTROLLER_STORE_CORRUPT");
      }
      return await fn(state, async next => {
        const text = encode(next);
        // Reuse the guarded exclusive-temp + datasync + rename implementation.
        // The parent directory is supplied by the caller; no roots/ACLs are changed.
        await commitTextFile(this.guard, target, text, { overwrite: true });
      });
    } finally {
      try { await releaseOwnedLock(lockPath, lock); }
      catch { /* Preserve the original cycle result/error; a leftover owned lock is recoverable on restart. */ }
    }
  }
}
