import { lstat, mkdir, realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentRuntimeIdentityStore, type RuntimeCredential } from "./agent-runtime-identity.js";
import { AgentWorkerMailbox } from "./agent-fabric-mailbox.js";
import { FabricStateFile } from "./agent-fabric-state.js";
import { FabricId } from "./agent-fabric-timeline.js";
import { FabricPayloadRefSchema, FabricWorkerSchema } from "./agent-fabric-worker.js";

const Binding = z.strictObject({ version: z.literal(1), controllerId: FabricId,
  device: FabricWorkerSchema.shape.device, initialized: z.boolean() });
const WorkerRequest = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("inbox"), workerId: z.string().uuid(), limit: z.number().int().min(1).max(64).default(32) }),
  z.strictObject({ operation: z.literal("ack"), workerId: z.string().uuid(), messageId: z.string().uuid() }),
  z.strictObject({ operation: z.literal("report"), workerId: z.string().uuid(), assignmentId: z.string().uuid(),
    kind: z.enum(["PROGRESS", "BLOCKED", "RESULT"]), key: FabricId, payloadRef: FabricPayloadRefSchema,
    ttlMs: z.number().int().min(1000).max(86_400_000).default(60_000) })
]);

/** Server-owned startup and worker surface. The directory is never taken from a worker request. */
export class AgentFabricService {
  readonly identities: AgentRuntimeIdentityStore;
  readonly mailbox: AgentWorkerMailbox;
  private readonly listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private closed = false;
  private constructor(readonly directory: string, controllerId: string) {
    this.identities = new AgentRuntimeIdentityStore(path.join(directory, "identities.json"));
    this.mailbox = new AgentWorkerMailbox(path.join(directory, "mailbox.json"), controllerId, this.identities,
      undefined, () => this.changed());
  }
  static async open(directory: string, controllerId: string,
    device: z.infer<typeof FabricWorkerSchema.shape.device> = null, initialize = true): Promise<AgentFabricService> {
    const expected = Binding.parse({ version: 1, controllerId, device, initialized: false });
    const absolute = path.resolve(directory);
    // State lives behind the existing protected .local-commander/native owner boundary.
    for (let current = absolute;; current = path.dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw Error("FABRIC_DIRECTORY_INVALID"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (path.dirname(current) === current) break;
    }
    if (initialize) await mkdir(absolute, { recursive: true, mode: 0o700 });
    if (!(await lstat(absolute)).isDirectory() || (await realpath(absolute)).toLowerCase() !== absolute.toLowerCase())
      throw Error("FABRIC_DIRECTORY_INVALID");
    const present = new Set<string>();
    for (const name of ["binding.json", "mailbox.json", "identities.json"]) {
      const file = await lstat(path.join(absolute, name)).catch(error => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (file && (!file.isFile() || file.isSymbolicLink())) throw Error("FABRIC_FILE_INVALID");
      if (file) present.add(name);
    }
    if (!present.has("binding.json") && present.size) throw Error("FABRIC_BINDING_MISSING");
    const binding = new FabricStateFile(path.join(absolute, "binding.json"), 2048, value => Binding.parse(value));
    const service = new AgentFabricService(absolute, controllerId);
    await binding.update(async state => {
      if (state.controllerId !== expected.controllerId || JSON.stringify(state.device) !== JSON.stringify(expected.device))
        throw Error("FABRIC_BINDING_CHANGED");
      if (!state.initialized) {
        if (!initialize) throw Error("FABRIC_INITIALIZATION_INCOMPLETE");
        try { await service.mailbox.initialize(); }
        catch (error) { if (!(error instanceof Error) || error.message !== "FABRIC_STATE_EXISTS") throw error; }
        state.initialized = true;
      }
      const snapshot = await service.mailbox.snapshot(); // Missing/corrupt established state is never reset.
      if (snapshot.workers.some(worker => worker.runtimeId !== null)) await lstat(path.join(absolute, "identities.json"));
    }, initialize ? () => expected : undefined);
    return service;
  }
  private changed(): void {
    for (const callback of this.listeners) { try { callback(); } catch {} }
  }
  subscribe = (callback: () => void): (() => void) => {
    if (this.closed || this.listeners.size >= 32) throw Error("FABRIC_OBSERVER_LIMIT");
    this.listeners.add(callback);
    try {
      if (!this.watcher) {
        this.watcher = watch(this.directory, { persistent: false }, (_event, file) => {
          if (file?.toString().toLowerCase() === "mailbox.json") this.changed();
        });
        this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
      }
    } catch { /* Same-process commit notifications still work; no polling fallback. */ }
    return () => { this.listeners.delete(callback); if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; } };
  };
  async worker(input: unknown, credential: RuntimeCredential): Promise<unknown> {
    const request = WorkerRequest.parse(input); // No register/assign/control/phase/peer surface.
    if (request.operation === "inbox") return this.mailbox.inbox(request.workerId, credential, request.limit);
    if (request.operation === "ack") return this.mailbox.ack(request.workerId, credential, request.messageId);
    return this.mailbox.report(request.workerId, credential, request.assignmentId, request.kind,
      { key: request.key, payloadRef: request.payloadRef, ttlMs: request.ttlMs });
  }
  close(): void { this.closed = true; this.watcher?.close(); this.watcher = undefined; this.listeners.clear(); }
}
