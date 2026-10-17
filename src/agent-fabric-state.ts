import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

const queues = new Map<string, Promise<void>>();

/** Protected server state, never a tool-supplied path. Atomic bounded updates shared by
 * identity and worker coordination. A leftover lock requires reconciliation, not stealing. */
export class FabricStateFile<T> {
  private readonly file: string;
  constructor(file: string, private readonly maxBytes: number, private readonly parse: (value: unknown) => T) {
    this.file = path.resolve(file);
  }
  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const key = process.platform === "win32" ? this.file.toLowerCase() : this.file;
    const result = (queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.then(() => {}, () => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }
  private async load(): Promise<T> {
    const handle = await open(this.file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.maxBytes) throw Error("FABRIC_STATE_LIMIT");
      const bytes = Buffer.alloc(this.maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > this.maxBytes) throw Error("FABRIC_STATE_LIMIT");
      try { return this.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))); }
      catch { throw Error("FABRIC_STATE_CORRUPT"); }
    } finally { await handle.close(); }
  }
  read(): Promise<T> { return this.serial(() => this.load()); }

  update<R>(fn: (state: T) => R | Promise<R>, create?: () => T): Promise<R> {
    return this.serial(async () => {
      if (create) await mkdir(path.dirname(this.file), { recursive: true });
      const lockPath = this.file + ".lock";
      const token = randomUUID();
      const lock = await open(lockPath, "wx", 0o600).catch(error => {
        if (error.code === "EEXIST") throw Error("FABRIC_STATE_BUSY");
        throw error;
      });
      try {
        await lock.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
        await lock.datasync();
        let state: T;
        try { state = await this.load(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
          state = create();
        }
        const result = await fn(state);
        const encoded = JSON.stringify(this.parse(state));
        if (Buffer.byteLength(encoded) > this.maxBytes) throw Error("FABRIC_STATE_LIMIT");
        const temporary = this.file + "." + token + ".tmp";
        const handle = await open(temporary, "wx", 0o600);
        try {
          try {
            await handle.writeFile(encoded, "utf8");
            await handle.datasync();
          } finally { await handle.close(); }
          await rename(temporary, this.file);
        }
        finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        return result;
      } finally {
        await lock.close();
        const current = await open(lockPath, "r");
        try {
          if ((await current.stat()).size > 1024 || JSON.parse(await current.readFile("utf8")).token !== token)
            throw Error("FABRIC_STATE_LOCK_CHANGED");
        } finally { await current.close(); }
        await unlink(lockPath);
      }
    });
  }
}
