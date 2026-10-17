import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { PathGuard } from "./guard.js";
import { readFilePrefix } from "./file-read.js";
import { commitTextFile } from "./file-write.js";
import { ExecutionScheduler } from "./scheduler.js";
import { ClaudeWorkerJobSchema, createClaudeControllerWorker } from "./controller-cli-worker.js";
import { TaskDefinitionSchema, parseControllerEvent } from "./task-controller.js";
import { FileControllerStore, type ControllerStore } from "./task-controller-store.js";
import { TaskControllerSupervisor } from "./task-controller-supervisor.js";
import { AgentFabricService } from "./agent-fabric-service.js";
import { coordinateFabricWorker } from "./agent-fabric-controller.js";

const absolute = z.string().refine(value => path.isAbsolute(value));
const ManifestSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]), controllerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/),
  stateFile: absolute, receiptDirectory: absolute,
  maxLaunchesPerStep: z.number().int().min(1).max(16),
  tasks: z.array(TaskDefinitionSchema).min(1).max(128),
  jobs: z.array(ClaudeWorkerJobSchema.extend({ cwd: absolute })).min(1).max(256)
});

/** Owner-local command only. No listener, automatic loop, proposal application or provider login. */
export async function runLocalController(policyRoot: string, argv: string[]) {
  const bootstrap = await import(new URL("../scripts/agent-bootstrap.mjs", import.meta.url).href);
  const policy = await bootstrap.loadAgentInstructions(policyRoot); // Before config, files or provider effects.
  if (argv.length === 1 && argv[0] === "--help") return {
    usage: ["node dist/controller-local.js init <manifest.json>", "node dist/controller-local.js status <manifest.json>",
      "node dist/controller-local.js step <manifest.json> --allow-model-request [--event <event.json>]"],
    documentation: "planning/AGENT_FABRIC.md#owner-local-controller-command"
  };
  const [operation, manifestFile, ...flags] = argv;
  if (!["init", "status", "step"].includes(operation ?? "") || !manifestFile ||
      flags.some((flag, index) => flag !== "--allow-model-request" && !(flag === "--event" && flags[index + 1]) && flags[index - 1] !== "--event") ||
      flags.filter(flag => flag === "--allow-model-request").length > 1 || flags.filter(flag => flag === "--event").length > 1 ||
      (operation !== "step" && flags.length)) throw Error("LOCAL_CONTROLLER_USAGE");
  if (operation === "step" && !flags.includes("--allow-model-request")) throw Error("LOCAL_CONTROLLER_MODEL_PERMISSION_REQUIRED");
  const eventIndex = flags.indexOf("--event");
  if (eventIndex >= 0 && flags[eventIndex + 1]!.startsWith("--")) throw Error("LOCAL_CONTROLLER_USAGE");
  const config = loadConfig();
  const guard = await PathGuard.create(config.roots, config.files.allowSensitiveFiles);
  await guard.resolveDirectory(policyRoot);
  async function readJson(file: string, limit: number): Promise<unknown> {
    const data = await readFilePrefix(guard, file, limit);
    if (data.truncated) throw Error("LOCAL_CONTROLLER_INPUT_LIMIT");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.data)); }
    catch { throw Error("LOCAL_CONTROLLER_INPUT_INVALID"); }
  }
  const manifestPath = await guard.resolveExisting(manifestFile);
  const manifest = ManifestSchema.parse(await readJson(manifestPath, 262_144));
  manifest.stateFile = await guard.resolveForWrite(manifest.stateFile);
  manifest.receiptDirectory = await guard.resolveDirectory(manifest.receiptDirectory);
  if (manifest.stateFile === manifestPath || manifest.stateFile + ".definition.json" === manifestPath)
    throw Error("LOCAL_CONTROLLER_PATH_CONFLICT");
  for (const job of manifest.jobs) {
    job.cwd = await guard.resolveDirectory(job.cwd);
    if (!manifest.tasks.some(task => task.id === job.taskId)) throw Error("LOCAL_CONTROLLER_JOB_UNKNOWN");
  }
  for (const task of manifest.tasks) {
    if (!manifest.jobs.some(job => job.taskId === task.id && job.role === "implementer") ||
        (task.verifierRequired && !manifest.jobs.some(job => job.taskId === task.id && job.role === "verifier")))
      throw Error("LOCAL_CONTROLLER_JOB_MISSING");
  }
  const event = eventIndex < 0 ? undefined : parseControllerEvent(await readJson(flags[eventIndex + 1]!, 16_384));
  const identity = JSON.stringify({ version: 1, policySha256: policy.evidence.sha256,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
  const fileStore = new FileControllerStore(guard, manifest.stateFile);
  const binding = manifest.stateFile + ".definition.json";
  let initialized = false;
  const store: ControllerStore = { exclusive: fn => fileStore.exclusive(async (state, save) => {
    if (operation === "init" && !initialized && state) throw Error("CONTROLLER_STORE_EXISTS");
    let previous: unknown;
    try { previous = await readJson(binding, 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (state || operation !== "init") throw Error("LOCAL_CONTROLLER_DEFINITION_MISSING");
    }
    if (previous !== undefined && JSON.stringify(previous) !== identity) throw Error("LOCAL_CONTROLLER_DEFINITION_CHANGED");
    if (previous === undefined) await commitTextFile(guard, binding, identity, { overwrite: false });
    return fn(state, save);
  }) };
  const slots = Math.min(4, config.shell.maxProcesses);
  const scheduler = new ExecutionScheduler({ read: 2, wait: 2, general: slots, cpu: slots }, guard);
  const worker = await createClaudeControllerWorker(policyRoot, { controllerId: manifest.controllerId,
    guard, scheduler, config, receiptDirectory: manifest.receiptDirectory, jobs: manifest.jobs });
  // v1 definitions remain unchanged. v2 explicitly opts into durable coordination;
  // its files are in the existing server-protected directory, never model-owned staging.
  const fabricKey = createHash("sha256").update(JSON.stringify([manifest.controllerId, manifest.stateFile])).digest("hex");
  if (manifest.version === 2) await store.exclusive(async () => {}); // Validate/persist definition before mailbox effects.
  const fabric = manifest.version === 2 ? await AgentFabricService.open(path.join(path.dirname(config.auth.oauthStatePath),
    ".local-commander", "controllers", fabricKey), manifest.controllerId, null, operation === "init") : undefined;
  const workerKey = (taskId: string, role: string) => "job-" + createHash("sha256").update(JSON.stringify([role, taskId])).digest("hex");
  if (fabric && operation === "init") {
    for (const job of manifest.jobs) await fabric.mailbox.register({ key: workerKey(job.taskId, job.role) });
  }
  const registered = fabric && (await fabric.mailbox.snapshot()).workers;
  const coordinated = fabric ? coordinateFabricWorker({ mailbox: fabric.mailbox, runtime: "claude", worker,
    assignment: action => {
      const job = manifest.jobs.find(job => job.taskId === action.taskId && job.role ===
        (action.type === "dispatch_verifier" ? "verifier" : "implementer"));
      if (!job) throw Error("FABRIC_WORKER_UNKNOWN");
      const registeredWorker = registered!.find(registeredWorker => registeredWorker.key === workerKey(action.taskId, job.role));
      if (!job || !registeredWorker) throw Error("FABRIC_WORKER_UNKNOWN");
      const encoded = JSON.stringify(job);
      return { workerId: registeredWorker.workerId, payloadRef: { id: "job-" + createHash("sha256").update(action.id).digest("hex"),
        sha256: createHash("sha256").update(encoded).digest("hex"), bytes: Buffer.byteLength(encoded) } };
    },
    result: async runId => {
      const result = await worker.result(runId);
      if (!result) return null;
      const encoded = JSON.stringify(result);
      return { payloadRef: { id: "receipt-" + createHash("sha256").update(runId).digest("hex"),
        sha256: createHash("sha256").update(encoded).digest("hex"), bytes: Buffer.byteLength(encoded) } };
    }
  }) : worker;
  let launchAttempts = 0;
  const supervisor = new TaskControllerSupervisor(manifest.controllerId, store, { runtimes: { claude: {
    status: coordinated.status,
    available: action => launchAttempts < manifest.maxLaunchesPerStep ? coordinated.available(action) : Promise.resolve(false),
    launch: action => {
      if (launchAttempts >= manifest.maxLaunchesPerStep) return Promise.resolve("conflict");
      launchAttempts++; // Count even a rejected admission, so the invocation cannot exceed its cap.
      return coordinated.launch(action);
    }
  } } }, { async send() { /* Notices remain in the durable snapshot and every local report. No external delivery. */ } });
  let actions: Awaited<ReturnType<typeof supervisor.step>> = [];
  try {
    if (operation === "init") { await supervisor.initialize(manifest.tasks); initialized = true; }
    else if (operation === "step") actions = await supervisor.step(event);
  } finally { await worker.drain(); }
  // Never reconcile or dispatch a second time just to refresh a report.
  const snapshot = await supervisor.snapshot();
  const tasks = await Promise.all(snapshot.tasks.map(async task => {
    const observed = !task.run ? null : task.run.runtime === "claude" ? await coordinated.status(task.run.id) : "unknown";
    const result = task.run?.runtime === "claude" ? await worker.result(task.run.id) : null;
    return { id: task.id, status: task.status, preferredRuntime: task.preferredRuntime,
      run: task.run ? { ...task.run, observed } : null,
      result: result ? { outcome: result.outcome, failure: result.failure, usage: result.usage, models: result.models,
        proposedFiles: result.proposal?.files.length ?? 0 } : null };
  }));
  fabric?.close();
  return { controllerId: manifest.controllerId, operation, policySha256: policy.evidence.sha256,
    launchAttempts, actions, tasks, notices: snapshot.notices };
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
const self = fileURLToPath(import.meta.url);
if (entry && (process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  const policyRoot = path.resolve(path.dirname(self), "..");
  try { console.log(JSON.stringify(await runLocalController(policyRoot, process.argv.slice(2)))); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({ error: /^(?:LOCAL_CONTROLLER|CONTROLLER|AGENT_INSTRUCTIONS)_[A-Z_]+$/.test(message) ? message : "LOCAL_CONTROLLER_FAILED" }));
    process.exitCode = 1;
  }
}
