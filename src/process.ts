import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { buildChildEnvironment } from "./child-environment.js";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./guard.js";
import { ProcessRegistry } from "./process-registry.js";
import { killWindowsDescendants, reclaimWindowsProcesses } from "./process-tree.js";
import { ByteBoundedTextTail, Utf8OutputTailBuffer } from "./output-buffer.js";

export interface CommandRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  descendantsHeldOutput?: boolean;
  stdinFailed?: boolean;
  durationMs: number;
}

// Grace after the launched process exits or is killed before output pipes held by descendants are abandoned.
const PIPE_HOLDOUT_MS = 2_000;

export function normalizeCommandName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /[\\/:]/.test(trimmed)) {
    throw new Error("command must be a bare executable name, not a path");
  }
  return trimmed.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

const WINDOWS_SCRIPT_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "tsx"]);
// Coding-agent CLIs. On Windows they install either as a native executable or as an npm/batch shim, so PATH decides
// how to launch them. They read a piped stdin before starting, so managed runs get a closed stdin.
const AGENT_CLI_COMMANDS = new Set(["claude", "codex", "agent", "cursor-agent"]);
const WINDOWS_LAUNCH_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

export interface Launch {
  file: string;
  shell: boolean;
}

// Same lookup as cmd.exe (first PATH directory with a PATHEXT match), except the cwd and relative entries are never searched.
/** Windows environment names are case-insensitive; a spread copy of process.env keeps the parent's spelling (PATH, Path, path). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function resolveWindowsLauncher(commandName: string, env: NodeJS.ProcessEnv = process.env): Launch | undefined {
  const extensions = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_LAUNCH_EXTENSIONS.includes(ext));
  for (const entry of (envValue(env, "PATH") ?? "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!path.win32.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const file = path.win32.join(dir, commandName + ext);
      try {
        if (statSync(file).isFile()) return { file, shell: ext === ".bat" || ext === ".cmd" };
      } catch {
        // Not in this directory.
      }
    }
  }
  return undefined;
}

// Every allowlisted command is pinned to the first PATH match before spawning. Both libuv (shell:false) and
// cmd.exe (shell:true) search the child's cwd first, so a repository that ships its own git.exe or npm.cmd
// would otherwise replace the owner's toolchain.
export function selectLaunch(command: string, commandName: string, env: NodeJS.ProcessEnv = process.env): Launch {
  if (process.platform !== "win32") return { file: command, shell: false };
  const resolved = resolveWindowsLauncher(commandName, env);
  if (resolved) {
    // Known script wrappers always launch through cmd.exe, even when a native shim exists alongside.
    return WINDOWS_SCRIPT_COMMANDS.has(commandName) ? { file: resolved.file, shell: true } : resolved;
  }
  throw new Error(
    `Command "${commandName}" was not found in an absolute PATH directory. The working directory is never searched; install the tool or fix PATH.`
  );
}

function validateWindowsShellArgs(args: string[]): void {
  for (const arg of args) {
    if (/[&|<>^%!\r\n]/.test(arg)) {
      throw new Error(
        "Windows script-wrapper commands and arguments may not contain cmd.exe metacharacters. Use a direct executable or split the operation into safer arguments."
      );
    }
  }
}

// Node joins shell arguments with spaces. cmd.exe leaves quoted text alone (its metacharacters are rejected above)
// and the target parses it with the usual CRT rules, so each argument arrives intact.
function quoteWindowsShellArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function validateRequest(config: AppConfig, request: CommandRequest): {
  commandName: string;
  args: string[];
  timeoutMs: number;
  launch: Launch;
} {
  const command = request.command.trim();
  const commandName = normalizeCommandName(command);
  if (!config.shell.allowedCommands.includes(commandName)) {
    throw new Error(
      `Command "${commandName}" is not allowed. Add it explicitly to shell.allowedCommands if required.`
    );
  }

  const args = request.args ?? [];
  if (args.length > 200) throw new Error("Too many command arguments");
  if (args.some((arg) => typeof arg !== "string" || arg.length > 32_768)) {
    throw new Error("Invalid or oversized command argument");
  }

  const requestedTimeout = request.timeoutMs ?? config.shell.maxTimeoutMs;
  const timeoutMs = Math.max(100, Math.min(requestedTimeout, config.shell.maxTimeoutMs));

  const launch = selectLaunch(command, commandName);
  if (launch.shell) validateWindowsShellArgs([launch.file, ...args]);

  return { commandName, args, timeoutMs, launch };
}

async function resolveCwd(guard: PathGuard, request: CommandRequest): Promise<string> {
  return request.cwd
    ? await guard.resolveDirectory(request.cwd)
    : guard.roots[0]!;
}

function spawnSafe(
  launch: Launch,
  args: string[],
  cwd: string,
  detached: boolean
): ChildProcessWithoutNullStreams {
  const { shell } = launch;
  return spawn(shell ? quoteWindowsShellArg(launch.file) : launch.file, shell ? args.map(quoteWindowsShellArg) : args, {
    cwd,
    shell,
    windowsHide: true,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildEnvironment(process.env, process.platform)
  });
}

async function killPidTree(pid: number, startedAtMs: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        env: buildChildEnvironment(process.env, process.platform)
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    // The launched process may already be gone while detached descendants still hold its pipes.
    await killWindowsDescendants(pid, startedAtMs).catch(() => 0);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

export async function runCommand(
  config: AppConfig,
  guard: PathGuard,
  request: CommandRequest,
  options: { input?: string } = {}
): Promise<CommandResult> {
  // Internal callers may pipe bounded context without putting it in argv/results.
  if (options.input !== undefined && (typeof options.input !== "string" || Buffer.byteLength(options.input) > 65_536))
    throw new Error("COMMAND_INPUT_LIMIT");
  const { commandName, args, timeoutMs, launch } = validateRequest(config, request);
  const cwd = await resolveCwd(guard, request);
  const stdout = new Utf8OutputTailBuffer(config.shell.maxOutputBytes);
  const stderr = new Utf8OutputTailBuffer(config.shell.maxOutputBytes);
  const started = Date.now();

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawnSafe(launch, args, cwd, false);
    let timedOut = false;
    let settled = false;
    let holdoutTimer: NodeJS.Timeout | undefined;
    let descendantsHeldOutput = false;
    let stdinFailed = false;

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.stdout.once("end", () => stdout.end());
    child.stderr.once("end", () => stderr.end());
    child.stdin.on("error", () => { stdinFailed = options.input !== undefined; });
    child.stdin.end(options.input);

    const timer = setTimeout(() => {
      timedOut = child.exitCode === null && child.signalCode === null;
      if (child.pid) void killPidTree(child.pid, started);
      holdoutTimer ??= setTimeout(() => finish(child.exitCode, child.signalCode), PIPE_HOLDOUT_MS);
    }, timeoutMs);

    // "close" also waits for every pipe holder; a descendant that outlives the process would hang the call.
    child.once("exit", () => {
      holdoutTimer ??= setTimeout(() => {
        descendantsHeldOutput = true;
        if (child.pid) void killPidTree(child.pid, started);
        finish(child.exitCode, child.signalCode);
      }, PIPE_HOLDOUT_MS);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      reject(error);
    });

    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    function finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(holdoutTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      stdout.end();
      stderr.end();
      resolve({
        command: commandName,
        args,
        cwd,
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        ...(descendantsHeldOutput ? { descendantsHeldOutput } : {}),
        ...(stdinFailed ? { stdinFailed } : {}),
        durationMs: Date.now() - started
      });
    }
  });
}

interface ManagedProcess {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  startedAtMs: number;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  output: ByteBoundedTextTail;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  stdoutEnded?: boolean;
  stderrEnded?: boolean;
  isClosed?: boolean;
  closed: Promise<void>;
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private nextId = 1;
  private pendingStarts = 0;

  private readonly registry: ProcessRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly guard: PathGuard,
    registryPath = config.auth?.oauthStatePath
      ? path.join(path.dirname(config.auth.oauthStatePath), ".local-commander", "processes.json")
      : undefined
  ) {
    this.registry = new ProcessRegistry(registryPath);
  }

  // Kill processes recorded by a previous run that did not shut down cleanly (Windows only:
  // POSIX children are process-group killed and a stale pid cannot be verified safely).
  async reclaimOrphans(): Promise<number> {
    const records = await this.registry.load();
    await this.registry.clear();
    if (process.platform !== "win32") return 0;
    return await reclaimWindowsProcesses(records).catch(() => 0);
  }

  async start(request: Omit<CommandRequest, "timeoutMs">): Promise<Record<string, unknown> & { id: string }> {
    this.reserveStartSlot();

    try {
      const { commandName, args, launch } = validateRequest(this.config, {
        ...request,
        timeoutMs: this.config.shell.maxTimeoutMs
      });
      const cwd = await resolveCwd(this.guard, request);
      const child = spawnSafe(launch, args, cwd, process.platform !== "win32");
      // No tool writes to a managed process's stdin. Agent CLIs wait on an open pipe (codex exec reads to EOF,
      // claude -p waits 3 s); other processes keep it open because some dev servers exit on stdin EOF.
      if (AGENT_CLI_COMMANDS.has(commandName)) {
        child.stdin.on("error", () => undefined);
        child.stdin.end();
      }
      const id = String(this.nextId++);
      let closed!: () => void;
      const record: ManagedProcess = {
        id,
        child,
        command: commandName,
        args,
        cwd,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        output: new ByteBoundedTextTail(this.config.shell.maxOutputBytes),
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        closed: new Promise<void>((resolve) => { closed = resolve; })
      };

      const finishStream = (stream: "stdout" | "stderr") => {
        const ended = stream === "stdout" ? "stdoutEnded" : "stderrEnded";
        if (record[ended]) return;
        record[ended] = true;
        record.output.appendText((stream === "stdout" ? record.stdoutDecoder : record.stderrDecoder).end());
      };
      child.stdout.on("data", (chunk: Buffer) => record.output.appendText(record.stdoutDecoder.write(chunk)));
      child.stderr.on("data", (chunk: Buffer) => record.output.appendText(record.stderrDecoder.write(chunk)));
      child.stdout.once("end", () => finishStream("stdout"));
      child.stderr.once("end", () => finishStream("stderr"));
      child.once("error", (error) => {
        finishStream("stdout");
        finishStream("stderr");
        record.output.appendText(`\n[process error] ${error.message}\n`);
        if (!child.pid && record.exitCode === undefined) {
          record.exitCode = null;
          record.exitedAt = new Date().toISOString();
        }
      });
      child.once("close", (exitCode, signal) => {
        finishStream("stdout");
        finishStream("stderr");
        record.exitCode = exitCode;
        record.signal = signal;
        record.exitedAt = new Date().toISOString();
        record.isClosed = true;
        closed();
      });

      this.processes.set(id, record);
      if (child.pid) {
        this.registry.add(id, { pid: child.pid, startedAtMs: record.startedAtMs });
        void record.closed.then(() => this.registry.remove(id));
      }
      return this.describe(record);
    } finally {
      this.releaseStartSlot();
    }
  }

  list(): Record<string, unknown>[] {
    return [...this.processes.values()].map((record) => this.describe(record));
  }

  waitForClose(id: string): Promise<void> {
    return this.require(id).closed;
  }

  output(id: string, tailChars = 32_000): Record<string, unknown> {
    const record = this.require(id);
    const full = record.output.toString();
    let tail = full.slice(-Math.max(1, Math.min(tailChars, 200_000)));
    // Avoid returning half of a UTF-16 surrogate pair when applying the UI character cap.
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    return {
      ...this.describe(record),
      output: tail,
      outputTruncated: record.output.truncated || tail.length < full.length
    };
  }

  async kill(id: string): Promise<Record<string, unknown>> {
    const record = this.require(id);
    let killConfirmed = record.exitCode !== undefined;

    if (record.child.pid && record.exitCode === undefined) {
      killConfirmed = await this.killAndConfirm(record, record.child.pid);
    } else if (record.child.pid && !record.isClosed) {
      // Exited but still holding output pipes through detached descendants.
      await this.sweepDescendants(record);
    }

    return {
      ...this.describe(record),
      killConfirmed
    };
  }

  async killAll(): Promise<void> {
    await Promise.all(
      [...this.processes.values()]
        .filter((record) => record.child.pid && !record.isClosed)
        .map(async (record) => {
          if (!record.child.pid) return;
          if (record.exitCode !== undefined) return await this.sweepDescendants(record);
          await this.killAndConfirm(record, record.child.pid);
        })
    );
  }

  // The exit window starts once the kill has been issued. On Windows, taskkill plus the
  // descendant sweep (a PowerShell process listing) can take seconds on a loaded machine.
  private async killAndConfirm(record: ManagedProcess, pid: number): Promise<boolean> {
    let closed = false;
    const onClose = () => { closed = true; };
    record.child.once("close", onClose);
    try {
      await killPidTree(pid, record.startedAtMs);
    } finally {
      record.child.off("close", onClose);
    }
    return closed || await this.waitForExit(record, 3_000);
  }

  private async sweepDescendants(record: ManagedProcess): Promise<void> {
    if (process.platform === "win32" && record.child.pid) {
      await killWindowsDescendants(record.child.pid, record.startedAtMs).catch(() => 0);
    }
  }

  private reserveStartSlot(): void {
    const activeCount = [...this.processes.values()].filter((item) => item.exitCode === undefined).length;
    if (activeCount + this.pendingStarts >= this.config.shell.maxProcesses) {
      throw new Error(`Maximum managed process count reached (${this.config.shell.maxProcesses})`);
    }
    this.pendingStarts += 1;
  }

  private releaseStartSlot(): void {
    this.pendingStarts = Math.max(0, this.pendingStarts - 1);
  }

  private async waitForExit(record: ManagedProcess, timeoutMs: number): Promise<boolean> {
    if (record.exitCode !== undefined) return true;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        record.child.off("close", onClose);
        resolve(record.exitCode !== undefined);
      }, timeoutMs);

      record.child.once("close", onClose);
    });
  }

  private require(id: string): ManagedProcess {
    const record = this.processes.get(id);
    if (!record) throw new Error(`Unknown process id: ${id}`);
    return record;
  }

  private describe(record: ManagedProcess): Record<string, unknown> & { id: string } {
    return {
      id: record.id,
      pid: record.child.pid ?? null,
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      startedAt: record.startedAt,
      running: record.exitCode === undefined,
      ...(record.exitedAt ? { exitedAt: record.exitedAt } : {}),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.signal !== undefined ? { signal: record.signal } : {})
    };
  }
}
