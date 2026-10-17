export type WorkerState = "idle" | "leased";

export interface WorkerLeaseInfo {
  requestId: number;
  tool: string;
}

export interface WorkerSnapshot {
  id: string;
  state: WorkerState;
  createdAt: string;
  changedAt: string;
  requestId?: number;
  tool?: string;
}

export interface WorkerPoolSnapshot {
  warmWorkers: number;
  growBy: number;
  maxWorkers: number;
  idleTtlMs: number;
  total: number;
  busy: number;
  idle: number;
  workers: WorkerSnapshot[];
}

interface WorkerRecord {
  id: string;
  state: WorkerState;
  createdAtMs: number;
  changedAtMs: number;
  requestId?: number;
  tool?: string;
}

export interface WorkerLease {
  id: string;
  release(): void;
}

export interface ElasticWorkerPoolOptions {
  warmWorkers?: number;
  growBy?: number;
  maxWorkers?: number;
  idleTtlMs?: number;
  now?: () => number;
}

export class ElasticWorkerPool {
  readonly warmWorkers: number;
  readonly growBy: number;
  readonly maxWorkers: number;
  readonly idleTtlMs: number;

  private readonly workers = new Map<string, WorkerRecord>();
  private readonly now: () => number;
  private nextId = 1;
  private reapTimer: NodeJS.Timeout | undefined;

  constructor(options: ElasticWorkerPoolOptions = {}) {
    this.warmWorkers = options.warmWorkers ?? 2;
    this.growBy = options.growBy ?? 2;
    this.maxWorkers = options.maxWorkers ?? 32;
    this.idleTtlMs = options.idleTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;

    if (!Number.isInteger(this.warmWorkers) || this.warmWorkers < 1 || this.warmWorkers > 32) {
      throw new Error("INVALID_WORKER_WARM_FLOOR");
    }
    if (!Number.isInteger(this.growBy) || this.growBy < 1 || this.growBy > 32) {
      throw new Error("INVALID_WORKER_GROWTH");
    }
    if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < this.warmWorkers || this.maxWorkers > 256) {
      throw new Error("INVALID_WORKER_MAX");
    }
    if (!Number.isInteger(this.idleTtlMs) || this.idleTtlMs < 10 || this.idleTtlMs > 3_600_000) {
      throw new Error("INVALID_WORKER_IDLE_TTL");
    }

    this.spawn(this.warmWorkers);
  }

  lease(info: WorkerLeaseInfo): WorkerLease {
    this.reap();
    let worker = this.firstIdle();
    if (!worker) {
      this.spawn(Math.min(this.growBy, this.maxWorkers - this.workers.size));
      worker = this.firstIdle();
    }
    if (!worker) throw new Error("WORKER_POOL_EXHAUSTED");

    worker.state = "leased";
    worker.requestId = info.requestId;
    worker.tool = info.tool;
    worker.changedAtMs = this.now();
    if (!this.firstIdle() && this.workers.size < this.maxWorkers) {
      this.spawn(Math.min(this.growBy, this.maxWorkers - this.workers.size));
    }
    this.scheduleReap();

    let released = false;
    return {
      id: worker.id,
      release: () => {
        if (released) return;
        released = true;
        this.release(worker!.id);
      }
    };
  }

  snapshot(): WorkerPoolSnapshot {
    this.reap();
    const records = [...this.workers.values()];
    const busy = records.filter(worker => worker.state === "leased").length;
    const idle = records.length - busy;
    return {
      warmWorkers: this.warmWorkers,
      growBy: this.growBy,
      maxWorkers: this.maxWorkers,
      idleTtlMs: this.idleTtlMs,
      total: records.length,
      busy,
      idle,
      workers: records.map(worker => ({
        id: worker.id,
        state: worker.state,
        createdAt: new Date(worker.createdAtMs).toISOString(),
        changedAt: new Date(worker.changedAtMs).toISOString(),
        ...(worker.requestId !== undefined ? { requestId: worker.requestId } : {}),
        ...(worker.tool !== undefined ? { tool: worker.tool } : {})
      }))
    };
  }

  private firstIdle(): WorkerRecord | undefined {
    return [...this.workers.values()].find(worker => worker.state === "idle");
  }

  private spawn(count: number): void {
    const now = this.now();
    for (let index = 0; index < count && this.workers.size < this.maxWorkers; index += 1) {
      const id = `worker-${this.nextId++}`;
      this.workers.set(id, { id, state: "idle", createdAtMs: now, changedAtMs: now });
    }
  }

  private release(id: string): void {
    const worker = this.workers.get(id);
    if (!worker || worker.state !== "leased") return;
    worker.state = "idle";
    worker.requestId = undefined;
    worker.tool = undefined;
    worker.changedAtMs = this.now();
    this.reap();
    this.scheduleReap();
  }

  private reap(): void {
    const now = this.now();
    const idle = [...this.workers.values()]
      .filter(worker => worker.state === "idle")
      .sort((left, right) => left.changedAtMs - right.changedAtMs);
    let removable = Math.max(0, idle.length - this.warmWorkers);
    for (const worker of idle) {
      if (removable <= 0) break;
      if (now - worker.changedAtMs < this.idleTtlMs) continue;
      this.workers.delete(worker.id);
      removable -= 1;
    }
  }

  private scheduleReap(): void {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = undefined;
    }

    const idle = [...this.workers.values()].filter(worker => worker.state === "idle");
    if (idle.length <= this.warmWorkers) return;

    const now = this.now();
    const oldestExtra = idle
      .sort((left, right) => left.changedAtMs - right.changedAtMs)
      .slice(0, idle.length - this.warmWorkers)[0];
    if (!oldestExtra) return;

    const delay = Math.max(1, this.idleTtlMs - (now - oldestExtra.changedAtMs));
    this.reapTimer = setTimeout(() => {
      this.reapTimer = undefined;
      this.reap();
      this.scheduleReap();
    }, delay);
    this.reapTimer.unref?.();
  }
}
