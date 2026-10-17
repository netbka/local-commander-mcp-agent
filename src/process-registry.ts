import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordedProcess } from "./process-tree.js";

// Persists the roots of managed processes so a restarted server can reclaim what a
// crashed one left behind. Writes are serialized and atomic; failures never affect
// process control and are logged once.
export class ProcessRegistry {
  private readonly active = new Map<string, RecordedProcess>();
  private queue: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(private readonly filePath: string | undefined) {}

  async load(): Promise<RecordedProcess[]> {
    if (!this.filePath) return [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is RecordedProcess =>
        Number.isSafeInteger(item?.pid) && item.pid > 0 && Number.isFinite(item?.startedAtMs));
    } catch { return []; }
  }

  async clear(): Promise<void> {
    const file = this.filePath;
    if (file) await this.enqueue(async () => { await unlink(file).catch(() => undefined); });
  }

  add(id: string, record: RecordedProcess): void {
    this.active.set(id, record);
    void this.enqueue(() => this.persist());
  }

  remove(id: string): void {
    if (this.active.delete(id)) void this.enqueue(() => this.persist());
  }

  flush(): Promise<void> { return this.queue; }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    if (this.active.size === 0) { await unlink(this.filePath).catch(() => undefined); return; }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.active.values()]), "utf8");
    await rename(temporary, this.filePath);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      if (!this.warned) { this.warned = true; console.error("[process] registry write failed:", error instanceof Error ? error.message : String(error)); }
    });
    return this.queue;
  }
}
