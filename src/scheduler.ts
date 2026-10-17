import os from "node:os";
import path from "node:path";
import { normalizeCommandName } from "./process.js";
import { isInside, type PathGuard } from "./guard.js";
import { gitResourcePaths } from "./git-resources.js";
import { ElasticWorkerPool, type ElasticWorkerPoolOptions } from "./worker-pool.js";

export type WorkloadClass = "read" | "wait" | "general" | "cpu";
export type LockMode = "shared" | "exclusive";

export interface ResourceClaim {
  key: string;
  mode: LockMode;
}

export interface SchedulerLimits {
  read: number;
  wait: number;
  general: number;
  cpu: number;
}

export interface SchedulerTaskSnapshot {
  requestId: number;
  tool: string;
  workload: WorkloadClass;
  queuedAt: string;
  deadlineAt: string;
  preparing: boolean;
  locks: ResourceClaim[];
}

export interface AdmissionOptions {
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  // Additional opaque controller resources; never replace ordinary path claims.
  controllerResources?: readonly string[];
}

interface QueueItem<T> {
  requestId: number;
  tool: string;
  workload: WorkloadClass;
  locks: ResourceClaim[];
  queuedAtMs: number;
  deadlineAtMs: number;
  prepared: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
  fn: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface LockState {
  shared: number;
  exclusive: boolean;
}

interface ClassStats {
  started: number;
  completed: number;
  failed: number;
  totalDurationMs: number;
}

const GIT_WAIT = new Set([
  "fetch",
  "pull",
  "push",
  "clone",
  "ls-remote",
  "submodule"
]);

const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "bun"]);
const WAIT_PACKAGE_ACTIONS = new Set(["install", "ci", "add", "update", "upgrade"]);
const CPU_PACKAGE_ACTIONS = new Set(["test", "build", "compile", "typecheck", "lint"]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function defaultSchedulerLimits(parallelism = os.availableParallelism?.() ?? os.cpus().length): SchedulerLimits {
  const cpu = Math.max(1, parallelism);
  return {
    read: clamp(cpu + 4, 8, 24),
    wait: clamp(cpu * 2, 16, 32),
    general: clamp(Math.ceil(cpu * 0.6), 4, 12),
    cpu: clamp(Math.ceil(cpu * 0.6), 2, 12)
  };
}

function normalizeResourcePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function commandParts(meta: Record<string, unknown>): { command: string; args: string[] } {
  const command = typeof meta.command === "string" ? normalizeCommandName(meta.command) : "";
  const args = Array.isArray(meta.args)
    ? meta.args.filter((item): item is string => typeof item === "string")
    : [];
  return { command, args };
}

function hasArg(args: string[], values: Set<string>): boolean {
  return args.some((arg) => values.has(arg.toLowerCase()));
}

export function classifyWorkload(tool: string, meta: Record<string, unknown>): WorkloadClass {
  if (
    ["fs_read", "fs_list", "fs_search", "git_status", "git_log", "git_diff", "project_snapshot", "process_list", "process_output", "scheduler_status"].includes(tool)
  ) {
    return "read";
  }

  if (tool === "localhost_request") return "wait";

  if (tool === "command_run" || tool === "process_start") {
    const { command, args } = commandParts(meta);

    if (command === "git" && GIT_WAIT.has((args[0] ?? "").toLowerCase())) return "wait";

    if (PACKAGE_MANAGERS.has(command)) {
      if (hasArg(args, WAIT_PACKAGE_ACTIONS)) return "wait";
      if (hasArg(args, CPU_PACKAGE_ACTIONS)) return "cpu";
    }

    if (
      hasArg(args, new Set(["build", "test", "compile", "typecheck"])) ||
      ["cargo", "rustc", "go", "dotnet"].includes(command)
    ) {
      return "cpu";
    }

    return "general";
  }

  return "general";
}

function repoClaim(meta: Record<string, unknown>, mode: LockMode): ResourceClaim[] {
  const candidate = normalizeResourcePath(meta.cwd ?? meta.path);
  return candidate ? [{ key: `repo:${candidate}`, mode }] : [];
}

function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (a.mode === "shared" && b.mode === "shared") return false;
  if (a.key === b.key) return true;
  // Distinct command cwds may overlap (a primary checkout can contain linked worktrees).
  // File and Git operations still fence overlapping command paths until the command finishes.
  if (a.key.startsWith("command:") && b.key.startsWith("command:")) return false;
  const left = /^(file|repo|command):/.test(a.key) ? a.key.slice(a.key.indexOf(":") + 1) : null;
  const right = /^(file|repo|command):/.test(b.key) ? b.key.slice(b.key.indexOf(":") + 1) : null;
  return !!left && !!right && (isInside(left, right) || isInside(right, left));
}

export function resourceClaims(tool: string, meta: Record<string, unknown>): ResourceClaim[] {
  if (["fs_read", "fs_list", "fs_search"].includes(tool)) {
    const file = normalizeResourcePath(meta.path);
    return file ? [{ key: `file:${file}`, mode: "shared" }] : [];
  }

  if (tool === "fs_write" || tool === "fs_replace") {
    const file = normalizeResourcePath(meta.path);
    return file ? [{ key: `file:${file}`, mode: "exclusive" }] : [];
  }

  if (["git_status", "git_log", "git_diff", "project_snapshot"].includes(tool)) {
    return repoClaim(meta, "shared");
  }

  if (tool === "command_run" || tool === "process_start") {
    // ponytail: arbitrary commands stay exclusive; narrower scopes require verified command profiles.
    return repoClaim(meta, "exclusive");
  }

  if (tool === "process_kill") {
    const id = typeof meta.id === "string" ? meta.id : "";
    return id ? [{ key: `process:${id}`, mode: "exclusive" }] : [];
  }

  if (tool === "process_output") {
    const id = typeof meta.id === "string" ? meta.id : "";
    return id ? [{ key: `process:${id}`, mode: "shared" }] : [];
  }

  if (tool === "localhost_request") {
    const method = typeof meta.method === "string" ? meta.method.toUpperCase() : "GET";
    if (["GET", "HEAD"].includes(method)) return [];
    if (typeof meta.url !== "string") return [];
    try {
      const parsed = new URL(meta.url);
      return [{ key: `service:${parsed.origin}`, mode: "exclusive" }];
    } catch {
      return [];
    }
  }

  return [];
}

export class ExecutionScheduler {
  readonly limits: SchedulerLimits;
  private readonly active: Record<WorkloadClass, number> = {
    read: 0,
    wait: 0,
    general: 0,
    cpu: 0
  };
  private readonly locks = new Map<string, LockState>();
  private readonly queue: Array<QueueItem<unknown>> = [];
  private readonly preparing = new Set<QueueItem<unknown>>();
  private readonly workers: ElasticWorkerPool;
  private draining = false;
  private readonly stats: Record<WorkloadClass, ClassStats> = {
    read: { started: 0, completed: 0, failed: 0, totalDurationMs: 0 },
    wait: { started: 0, completed: 0, failed: 0, totalDurationMs: 0 },
    general: { started: 0, completed: 0, failed: 0, totalDurationMs: 0 },
    cpu: { started: 0, completed: 0, failed: 0, totalDurationMs: 0 }
  };

  constructor(
    limits: SchedulerLimits = defaultSchedulerLimits(),
    private readonly guard?: PathGuard,
    workerOptions: ElasticWorkerPoolOptions = {}
  ) {
    this.limits = { ...limits };
    const maxWorkers = Object.values(this.limits).reduce((sum, value) => sum + value, 0);
    this.workers = new ElasticWorkerPool({ ...workerOptions, maxWorkers: workerOptions.maxWorkers ?? maxWorkers });
  }

  run<T>(
    requestId: number,
    tool: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T> | T,
    options: AdmissionOptions = {}
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new Error("CANCELLED_BEFORE_ACCEPTANCE"));
    const resources = options.controllerResources ?? [];
    if (resources.length > 128 || resources.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id)))
      return Promise.reject(new Error("INVALID_CONTROLLER_RESOURCES"));
    const additional: ResourceClaim[] = [...new Set(resources)].map(id => ({ key: `controller:${id}`, mode: "exclusive" }));
    const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
    if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 30_000) {
      return Promise.reject(new Error("INVALID_ADMISSION_TIMEOUT"));
    }
    // A canceled filesystem lookup still occupies preparation capacity until it settles.
    if (new Set([...this.queue, ...this.preparing]).size >= 128) return Promise.reject(new Error("SCHEDULER_QUEUE_FULL"));

    const workload = classifyWorkload(tool, meta);
    const locks = this.guard ? [] : [...resourceClaims(tool, meta), ...additional];

    return new Promise<T>((resolve, reject) => {
      const queuedAtMs = Date.now();
      const item = {
        requestId,
        tool,
        workload,
        locks,
        queuedAtMs,
        deadlineAtMs: queuedAtMs + queueTimeoutMs,
        prepared: !this.guard,
        signal: options.signal,
        fn,
        resolve,
        reject
      } as QueueItem<unknown>;
      item.onAbort = () => this.rejectQueued(item, "CANCELLED_BEFORE_ACCEPTANCE");
      item.timer = setTimeout(() => this.rejectQueued(item, "ADMISSION_DEADLINE_EXPIRED"), queueTimeoutMs);
      item.signal?.addEventListener("abort", item.onAbort, { once: true });
      this.queue.push(item);
      if (this.guard) {
        this.preparing.add(item);
        void this.prepareClaims(tool, meta).then((claims) => {
          if (!this.queue.includes(item)) return;
          item.locks = [...claims, ...additional];
          item.prepared = true;
          this.scheduleDrain();
        }, (error: unknown) => this.rejectQueued(item, error instanceof Error ? error : new Error("RESOURCE_RESOLUTION_FAILED")))
          .finally(() => { this.preparing.delete(item); });
      }
      this.scheduleDrain();
    });
  }

  snapshot(): Record<string, unknown> {
    const queued: SchedulerTaskSnapshot[] = this.queue.map((item) => ({
      requestId: item.requestId,
      tool: item.tool,
      workload: item.workload,
      queuedAt: new Date(item.queuedAtMs).toISOString(),
      deadlineAt: new Date(item.deadlineAtMs).toISOString(),
      preparing: !item.prepared,
      locks: item.locks
    }));

    const avgDurationMs = Object.fromEntries(
      (Object.keys(this.stats) as WorkloadClass[]).map((workload) => {
        const item = this.stats[workload];
        const finished = item.completed + item.failed;
        return [workload, finished ? Math.round(item.totalDurationMs / finished) : 0];
      })
    );

    return {
      limits: this.limits,
      active: { ...this.active },
      preparing: this.preparing.size,
      queued,
      locks: [...this.locks.entries()].map(([key, state]) => ({ key, ...state })),
      workers: this.workers.snapshot(),
      stats: this.stats,
      avgDurationMs
    };
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private async prepareClaims(tool: string, meta: Record<string, unknown>): Promise<ResourceClaim[]> {
    const guard = this.guard!;
    if (tool === "fs_write" || tool === "fs_replace") {
      return resourceClaims(tool, { ...meta, path: await guard.resolveForWrite(String(meta.path)) });
    }
    if (tool === "fs_read") {
      const filename = await guard.resolveExisting(String(meta.path));
      guard.assertSafeFile(filename);
      return resourceClaims(tool, { ...meta, path: filename });
    }
    if (["fs_list", "fs_search"].includes(tool)) {
      return resourceClaims(tool, { ...meta, path: await guard.resolveDirectory(String(meta.path)) });
    }
    if (["git_status", "git_log", "git_diff", "project_snapshot"].includes(tool)) {
      const cwd = await guard.resolveDirectory(String(meta.path));
      const paths = [cwd, ...await gitResourcePaths(guard, cwd)];
      return this.gitClaims(paths, "shared");
    }
    if (tool === "command_run" || tool === "process_start") {
      const cwd = await guard.resolveDirectory(typeof meta.cwd === "string" && meta.cwd ? meta.cwd : guard.roots[0]!);
      const { command, args } = commandParts(meta);
      // Ordinary executables are isolated to their canonical cwd. Treating every command as a
      // Git mutation also claims a linked worktree's shared commondir and falsely serializes
      // independent agent worktrees. Only Git itself receives Git metadata/common-dir fencing.
      if (command !== "git") return [{ key: `command:${normalizeResourcePath(cwd)!}`, mode: "exclusive" }];
      const paths = [cwd, ...await gitResourcePaths(guard, cwd, args)];
      return this.gitClaims(paths, "exclusive");
    }
    return resourceClaims(tool, meta);
  }

  private gitClaims(paths: string[], mode: LockMode): ResourceClaim[] {
    return [...new Set(paths.map(filename => normalizeResourcePath(filename)!))].map(filename => ({ key: `repo:${filename}`, mode }));
  }

  private cleanupQueued(item: QueueItem<unknown>): void {
    clearTimeout(item.timer);
    if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
  }

  private rejectQueued(item: QueueItem<unknown>, reason: string | Error): void {
    const index = this.queue.indexOf(item);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.cleanupQueued(item);
    item.reject(typeof reason === "string" ? new Error(reason) : reason);
    this.scheduleDrain();
  }

  private drain(): void {
    try {
      let startedAny = true;
      while (startedAny) {
        startedAny = false;

        for (let index = 0; index < this.queue.length; index++) {
          const item = this.queue[index]!;
          if (item.signal?.aborted || Date.now() >= item.deadlineAtMs) {
            this.rejectQueued(item, item.signal?.aborted ? "CANCELLED_BEFORE_ACCEPTANCE" : "ADMISSION_DEADLINE_EXPIRED");
            index -= 1;
            continue;
          }
          if (!this.canStart(item, index)) continue;

          this.queue.splice(index, 1);
          this.cleanupQueued(item);
          index -= 1;
          this.startItem(item);
          startedAny = true;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.some((item, index) => this.canStart(item, index))) this.scheduleDrain();
    }
  }

  private canStart(item: QueueItem<unknown>, index: number): boolean {
    // ponytail: unresolved scope blocks later admission; separate preparation pools only after measured need.
    if (!item.prepared || this.queue.slice(0, index).some((older) => !older.prepared)) return false;
    if (this.active[item.workload] >= this.limits[item.workload]) return false;

    // Preserve order for conflicting work, even when an earlier writer awaits a pool slot.
    // ponytail: scan the queue; index claims only if measured queue cost warrants it.
    if (this.queue.slice(0, index).some((older) => older.locks.some((a) =>
      item.locks.some((b) => claimsConflict(a, b))
    ))) return false;

    return item.locks.every((claim) => [...this.locks].every(([key, state]) =>
      !claimsConflict(claim, { key, mode: state.exclusive ? "exclusive" : "shared" })
    ));
  }

  private acquire(claims: ResourceClaim[]): void {
    for (const claim of claims) {
      const state = this.locks.get(claim.key) ?? { shared: 0, exclusive: false };
      if (claim.mode === "shared") state.shared += 1;
      else state.exclusive = true;
      this.locks.set(claim.key, state);
    }
  }

  private release(claims: ResourceClaim[]): void {
    for (const claim of claims) {
      const state = this.locks.get(claim.key);
      if (!state) continue;

      if (claim.mode === "shared") state.shared = Math.max(0, state.shared - 1);
      else state.exclusive = false;

      if (!state.exclusive && state.shared === 0) this.locks.delete(claim.key);
      else this.locks.set(claim.key, state);
    }
  }

  private startItem(item: QueueItem<unknown>): void {
    let worker;
    try {
      worker = this.workers.lease({ requestId: item.requestId, tool: item.tool });
    } catch (error) {
      this.stats[item.workload].failed += 1;
      item.reject(error);
      this.scheduleDrain();
      return;
    }

    this.active[item.workload] += 1;
    this.acquire(item.locks);
    this.stats[item.workload].started += 1;
    const startedAt = Date.now();

    const finish = () => {
      this.stats[item.workload].totalDurationMs += Date.now() - startedAt;
      this.active[item.workload] = Math.max(0, this.active[item.workload] - 1);
      this.release(item.locks);
      worker.release();
      this.scheduleDrain();
    };

    void Promise.resolve()
      .then(() => item.fn())
      .then((value) => {
        this.stats[item.workload].completed += 1;
        finish();
        item.resolve(value);
      }, (error) => {
        this.stats[item.workload].failed += 1;
        finish();
        item.reject(error);
      });
  }
}
