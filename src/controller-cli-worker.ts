import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { isInside, type PathGuard } from "./guard.js";
import { commitTextFile } from "./file-write.js";
import { readFilePrefix } from "./file-read.js";
import { resolveWindowsLauncher, runCommand, type CommandResult } from "./process.js";
import { discoverLocalRuntimes, inspectRuntimeAuthentication } from "./runtime-discovery.js";
import type { ExecutionScheduler } from "./scheduler.js";
import type { ControllerAction } from "./task-controller.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const role = z.enum(["implementer", "verifier"]);
const ownedPath = z.string().min(1).max(240).refine(value => !/[\\:]/.test(value) && !path.posix.isAbsolute(value) &&
  value.split("/").every(part => part && part !== "." && part !== ".."));
export const ClaudeWorkerJobSchema = z.strictObject({
  taskId: id, role, cwd: z.string().min(1), target: z.string().min(1).max(4096),
  context: z.string().max(32_768), ownedPaths: z.array(ownedPath).min(1).max(32), model,
  timeoutMs: z.number().int().min(500).max(180_000),
  maxOutputBytes: z.number().int().min(4096).max(131_072),
  maxOutputTokens: z.number().int().min(256).max(16_384),
  maxCostUsd: z.number().positive().max(10)
});
export type ClaudeWorkerJob = z.infer<typeof ClaudeWorkerJobSchema>;
const ActionSchema = z.strictObject({
  type: z.enum(["dispatch_implementer", "dispatch_verifier"]), id: runId, taskId: id,
  resources: z.array(id).max(128), assignee: id.nullable()
});
type Dispatch = Extract<ControllerAction, { resources: string[] }>;
const ProposalSchema = z.strictObject({
  summary: z.string().max(4096),
  files: z.array(z.strictObject({ path: ownedPath, content: z.string().max(131_072) })).max(32),
  blockers: z.array(z.string().max(1024)).max(16)
});
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const ResultSchema = z.strictObject({
  outcome: z.enum(["proposal_ready", "failed"]),
  failure: z.enum(["cli_failed", "input_delivery_failed", "output_limit", "invalid_proposal"]).nullable(),
  proposal: ProposalSchema.nullable(),
  usage: z.strictObject({ inputTokens: tokens, outputTokens: tokens }),
  models: z.array(z.strictObject({ model, inputTokens: tokens, outputTokens: tokens })).max(4)
});
const ReceiptSchema = z.strictObject({
  version: z.literal(1), controllerId: id, action: ActionSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), policySha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestedModel: model, phase: z.enum(["not_started", "launching", "finished"]), result: ResultSchema.nullable()
});
type Receipt = z.infer<typeof ReceiptSchema>;
type Result = z.infer<typeof ResultSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeFlags = ["--safe-mode", "--restricted", "--no-chrome", "--disable-slash-commands", "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "mcp__*", "--tools", ""];
let requestSequence = 0;

/** Development/personal-runtime adapter. The caller supplies approved context and an existing
 * staging directory. It never applies proposals, accepts a verifier verdict, or grants permissions.
 * The required bootstrap is shared with every other repository-owned model runner. */
export async function createClaudeControllerWorker(policyRoot: string, options: {
  controllerId: string; guard: PathGuard; scheduler: ExecutionScheduler; config: AppConfig;
  receiptDirectory: string; jobs: ClaudeWorkerJob[];
}) {
  const bootstrap = await import(new URL("../scripts/agent-bootstrap.mjs", import.meta.url).href);
  const policy = await bootstrap.loadAgentInstructions(policyRoot); // Before configuration or writes.
  const { guard, scheduler } = options;
  const controllerId = id.parse(options.controllerId);
  await guard.resolveDirectory(policyRoot);
  const directory = await guard.resolveDirectory(options.receiptDirectory);
  const config = { ...options.config, shell: { ...options.config.shell, allowedCommands: [...options.config.shell.allowedCommands] } };
  const jobs = z.array(ClaudeWorkerJobSchema).min(1).max(256).parse(options.jobs);
  const assignments = new Map<string, ClaudeWorkerJob>();
  for (const job of jobs) {
    job.cwd = await guard.resolveDirectory(job.cwd);
    if (job.timeoutMs > config.shell.maxTimeoutMs || job.maxOutputBytes > config.shell.maxOutputBytes ||
        Buffer.byteLength(job.context) > 65_536 || new Set(job.ownedPaths).size !== job.ownedPaths.length)
      throw Error("CONTROLLER_WORKER_LIMIT");
    for (const filename of job.ownedPaths) {
      const target = await guard.resolveForWrite(path.join(job.cwd, filename));
      if (!isInside(job.cwd, target)) throw Error("CONTROLLER_WORKER_SCOPE");
    }
    const key = job.role + ":" + job.taskId;
    if (assignments.has(key)) throw Error("CONTROLLER_WORKER_DUPLICATE_JOB");
    assignments.set(key, job);
  }
  const assignment = (action: Dispatch) => assignments.get((action.type === "dispatch_verifier" ? "verifier:" : "implementer:") + action.taskId);
  const fingerprint = (action: Dispatch, job: ClaudeWorkerJob) => hash(JSON.stringify([controllerId, action, job, policy.evidence.sha256]));
  const filename = (value: string) => path.join(directory, hash(JSON.stringify([controllerId, runId.parse(value)])) + ".json");
  const ready = new Map<string, string>();
  const active = new Map<string, { ack: Promise<"started" | "conflict" | "not_started">; done: Promise<void> }>();
  let launchQueue: Promise<unknown> = Promise.resolve();
  const failed = (failure: Result["failure"]): Result => ({ outcome: "failed", failure, proposal: null,
    usage: { inputTokens: null, outputTokens: null }, models: [] });

  async function read(file: string, limit = 262_144): Promise<unknown | undefined> {
    try {
      const data = await readFilePrefix(guard, file, limit);
      if (data.truncated) throw Error();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw Error("CONTROLLER_WORKER_RECEIPT_UNKNOWN");
    }
  }
  async function receipt(value: string): Promise<Receipt | undefined> {
    const data = await read(filename(value));
    if (data === undefined) return undefined;
    const parsed = ReceiptSchema.safeParse(data);
    if (!parsed.success) throw Error("CONTROLLER_WORKER_RECEIPT_UNKNOWN");
    const record = parsed.data, job = assignment(record.action);
    if (!job || record.action.id !== value || record.controllerId !== controllerId ||
        record.fingerprint !== fingerprint(record.action, job) || record.policySha256 !== policy.evidence.sha256 ||
        record.requestedModel !== job.model || (record.phase === "finished") !== (record.result !== null) ||
        (record.result && ((record.result.outcome === "proposal_ready") !== (record.result.proposal !== null) ||
          (record.result.outcome === "failed") !== (record.result.failure !== null))) ||
        (record.result?.proposal && (record.result.proposal.files.some(file => !job.ownedPaths.includes(file.path)) ||
          new Set(record.result.proposal.files.map(file => file.path)).size !== record.result.proposal.files.length)))
      throw Error("CONTROLLER_WORKER_RECEIPT_UNKNOWN");
    return record;
  }
  async function save(record: Receipt, overwrite: boolean) {
    await commitTextFile(guard, filename(record.action.id), JSON.stringify(record), { overwrite });
  }
  function parseResult(output: CommandResult, job: ClaudeWorkerJob): Result | undefined {
    // A timeout or held pipe is not proof that the process tree finished.
    if (output.timedOut || output.signal || output.descendantsHeldOutput || output.exitCode === null) return undefined;
    if (output.exitCode !== 0) return failed("cli_failed");
    if (output.stdinFailed) return failed("input_delivery_failed");
    if (output.stdoutTruncated || output.stderrTruncated || Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > job.maxOutputBytes)
      return failed("output_limit");
    try {
      const envelope = JSON.parse(output.stdout);
      if (envelope.type !== "result" || envelope.subtype !== "success" || envelope.is_error !== false ||
          envelope.num_turns !== 1 || typeof envelope.result !== "string") throw Error();
      const proposal = ProposalSchema.parse(JSON.parse(envelope.result));
      if (proposal.files.some(file => !job.ownedPaths.includes(file.path)) || new Set(proposal.files.map(file => file.path)).size !== proposal.files.length) throw Error();
      const count = (value: unknown) => tokens.safeParse(value).success ? value as number | null : null;
      const models = Object.entries(envelope.modelUsage ?? {}).map(([name, usage]) => {
        const values = usage as Record<string, unknown> | null;
        return { model: name, inputTokens: count(values?.inputTokens), outputTokens: count(values?.outputTokens) };
      });
      return ResultSchema.parse({ outcome: "proposal_ready", failure: null, proposal,
        usage: { inputTokens: count(envelope.usage?.input_tokens), outputTokens: count(envelope.usage?.output_tokens) }, models });
    } catch { return failed("invalid_proposal"); }
  }
  const nativeLauncher = () => process.platform === "win32" ? resolveWindowsLauncher("claude") : undefined;
  async function available(input: Dispatch): Promise<boolean> {
    try {
      const action = ActionSchema.parse(input), job = assignment(action), launcher = nativeLauncher();
      ready.delete(action.id);
      if (!job || !launcher || launcher.shell || !config.shell.allowedCommands.includes("claude")) return false;
      const probeConfig = { ...config, shell: { ...config.shell, maxOutputBytes: Math.min(65_536, config.shell.maxOutputBytes) } };
      const probe = (args: string[]) => scheduler.run(--requestSequence, "command_run", { command: "claude", cwd: job.cwd },
        () => runCommand(probeConfig, guard, { command: "claude", cwd: job.cwd, args, timeoutMs: 10_000 }), { queueTimeoutMs: 100 });
      const help = await probe(["--help"]);
      if (help.exitCode !== 0 || help.timedOut || help.signal || help.stdoutTruncated || help.stderrTruncated || help.descendantsHeldOutput ||
          !["--safe-mode", "--restricted", "--tools", "--strict-mcp-config", "--no-session-persistence"].every(flag => help.stdout.includes(flag))) return false;
      const facts = discoverLocalRuntimes(config.shell.allowedCommands).filter(fact => fact.provider === "claude");
      const auth = await inspectRuntimeAuthentication(facts, request => probe(["--safe-mode", "--restricted", ...request.args!]));
      if (auth[0]?.authentication !== "signed_in") return false;
      if (ready.size >= 128) ready.clear();
      ready.set(action.id, fingerprint(action, job));
      return true;
    } catch { return false; }
  }
  async function start(input: Dispatch): Promise<"started" | "conflict" | "not_started"> {
    const action = ActionSchema.parse(input), job = assignment(action);
    if (!job) return "not_started";
    const expected = fingerprint(action, job);
    let record = await receipt(action.id);
    if (record && record.fingerprint !== expected) throw Error("CONTROLLER_WORKER_ID_CONFLICT");
    if (record?.phase === "finished") return "started"; // A failure remains a failure; no second request.
    if (active.has(action.id)) return active.get(action.id)!.ack;
    if (record?.phase === "launching") throw Error("CONTROLLER_WORKER_OUTCOME_UNKNOWN");
    if (ready.get(action.id) !== expected) return record ? "conflict" : "not_started";
    ready.delete(action.id);
    if (!record) {
      record = { version: 1, controllerId, action, fingerprint: expected, policySha256: policy.evidence.sha256,
        requestedModel: job.model, phase: "not_started", result: null };
      try { await save(record, false); }
      catch {
        record = await receipt(action.id);
        if (!record || record.fingerprint !== expected || record.phase !== "not_started") throw Error("CONTROLLER_WORKER_OUTCOME_UNKNOWN");
      }
    }
    let resolve!: (value: "started" | "conflict" | "not_started") => void, reject!: (reason: Error) => void;
    const ack = new Promise<"started" | "conflict" | "not_started">((yes, no) => { resolve = yes; reject = no; });
    let admitted = false;
    const done = scheduler.run(--requestSequence, "command_run", { command: "claude", cwd: job.cwd }, async () => {
      admitted = true;
      const lock = filename(action.id) + ".lock", token = randomUUID();
      await commitTextFile(guard, lock, JSON.stringify(token), { overwrite: false });
      try {
        const current = await receipt(action.id);
        if (!current || current.fingerprint !== expected) throw Error();
        if (current.phase === "finished") { resolve("started"); return; }
        if (current.phase !== "not_started") throw Error();
        const launcher = nativeLauncher();
        if (!launcher || launcher.shell) { resolve("not_started"); return; }
        const promptFile = filename(action.id) + ".prompt.txt";
        const system = bootstrap.buildAgentSystemPrompt(policy,
          `Acceptance target: ${job.target}\nOwned paths: ${JSON.stringify(job.ownedPaths)}\nReturn JSON only: {summary,files:[{path,content}],blockers}. No tools or execution. This is a ${job.role} proposal for coordinator review.`);
        // The prompt is durable with the intent. A crash leaves it for review, never replay.
        current.phase = "launching";
        await save(current, true);
        await commitTextFile(guard, promptFile, system, { overwrite: false });
        const settings = JSON.stringify({ disableAllHooks: true, env: {
          CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_RETRY_WATCHDOG: "0", CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(job.maxOutputTokens), API_TIMEOUT_MS: String(job.timeoutMs),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1"
        } });
        const args = [...safeFlags, "--print", "--output-format", "json", "--no-session-persistence", "--permission-mode", "dontAsk",
          "--permission-prompts", "none", "--max-turns", "1", "--model", job.model, "--max-budget-usd", String(job.maxCostUsd),
          "--settings", settings, "--system-prompt-file", promptFile];
        const running = runCommand({ ...config, shell: { ...config.shell, maxOutputBytes: job.maxOutputBytes } }, guard,
          { command: "claude", cwd: job.cwd, args, timeoutMs: job.timeoutMs }, { input: job.context });
        resolve("started"); // Durable acceptance; this does not assert a successful model request.
        const result = parseResult(await running, job);
        if (result) { current.phase = "finished"; current.result = result; await save(current, true); }
      } finally {
        // Never remove another writer's lock. Ambiguous receipts remain launching.
        if (await read(lock, 1024) === token) await unlink(await guard.resolveExisting(lock));
      }
    }, { controllerResources: action.resources, queueTimeoutMs: 100 }).catch(() => {
      if (!admitted) resolve("conflict"); else reject(Error("CONTROLLER_WORKER_OUTCOME_UNKNOWN"));
    }).finally(() => { active.delete(action.id); });
    active.set(action.id, { ack, done });
    return ack;
  }
  return {
    available,
    launch(input: Dispatch) {
      // ponytail: serialize admission (not model execution) to fence duplicate local calls.
      const result = launchQueue.then(() => start(input));
      launchQueue = result.catch(() => undefined);
      return result;
    },
    async status(value: string): Promise<"not_started" | "running" | "exited" | "unknown"> {
      try {
        const record = await receipt(value);
        if (!record) return "unknown"; // A missing registry is never absence proof.
        if (record.phase === "finished") return "exited";
        if (record.phase === "launching") return active.has(value) ? "running" : "unknown";
        return await read(filename(value) + ".lock", 1024) === undefined ? "not_started" : "unknown";
      } catch { return "unknown"; }
    },
    async result(value: string): Promise<Result | null> {
      try { return (await receipt(value))?.result ?? null; } catch { return null; }
    },
    async drain(): Promise<void> { await Promise.all([...active.values()].map(item => item.done)); }
  };
}
