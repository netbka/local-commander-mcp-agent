import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { lstat, readFile, mkdir, open, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { commandPreview, contextSummary } from "../packages/agent-cli/bin/monitor-context.mjs";
import { resolveWindowsLauncher, type CommandRequest, type CommandResult } from "./process.js";

const Entry = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{16}$/), command: z.string().max(240).refine(v => !/[\x00-\x1f\x7f]/.test(v)),
  directory: z.string().max(96).nullable(), outcome: z.enum(["succeeded", "failed"]),
  code: z.enum(["EXIT_NONZERO", "TIMED_OUT", "INCOMPLETE", "NOT_FOUND", "NOT_ALLOWED", "COMMAND_ERROR"]).nullable(),
  exitCode: z.number().int().nullable(), at: z.number().int().positive(), count: z.number().int().min(1).max(1_000_000)
});
const State = z.strictObject({ version: z.literal(1), platform: z.string().max(16), entries: z.array(Entry).max(32) });
type RecordEntry = z.infer<typeof Entry>;

/** Per-server PC facts and bounded outcomes, never a permission or an executable recipe. */
export class HostMemory {
  private entries: RecordEntry[] = [];
  private loaded?: Promise<void>;
  private writing = Promise.resolve();
  private errors = 0;
  private facts?: { at: number; value: ReturnType<HostMemory["discover"]> };
  constructor(private readonly file: string, private readonly allowed: readonly string[], private readonly programs?: Readonly<Record<string, string>>) {}
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const stat = await lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw Error("HOST_MEMORY_INVALID");
        const data = State.parse(JSON.parse(await readFile(this.file, "utf8")));
        if (data.platform === process.platform) this.entries = data.entries.filter(e => e.at <= Date.now() && Date.now() - e.at < 30 * 86400_000);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.errors++; }
    })();
    await this.loaded;
  }
  private discover() {
    const commands = this.allowed.slice(0, 32).filter(name => /^[A-Za-z0-9_.-]{1,40}$/.test(name)).map(command => {
      let available = command === "node" && !this.programs;
      if (this.programs) { try { const executable = this.programs[command]; available = !!executable && path.isAbsolute(executable) && statSync(executable).isFile(); } catch { available = false; } }
      if (!this.programs && !available && process.platform === "win32") available = !!resolveWindowsLauncher(command);
      else if (!this.programs && !available) available = (process.env.PATH ?? "").split(path.delimiter).some(dir => {
        if (!path.isAbsolute(dir)) return false;
        try { const file = path.join(dir, command); accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
      });
      return { command, available, registeredOrAllowed: true };
    });
    return { platform: process.platform, os: os.type(), release: os.release(), architecture: process.arch,
      node: process.version, shell: process.platform === "win32" ? "Windows; prefer available powershell/pwsh or structured argv" : "POSIX; structured argv",
      commands, commandsTruncated: this.allowed.length > 32, packages: "Executable availability only; package versions are not inferred", observedAt: new Date().toISOString() };
  }
  async context() {
    await this.load();
    if (!this.facts || Date.now() - this.facts.at > 60_000) this.facts = { at: Date.now(), value: this.discover() };
    return { system: this.facts.value, workedCommands: this.entries.filter(e => e.outcome === "succeeded").slice(-8).reverse(), recentFailures: this.entries.filter(e => e.outcome === "failed").slice(-8).reverse(), persistenceErrors: this.errors,
      guidance: (process.platform === "win32" ? "This is Windows: do not assume Bash exists. Use an available approved shell or structured argv. " : "") + "Use current system facts before discovery. Success is observed exit 0, not approval for reuse. Failures are hints; permissions remain unchanged." };
  }
  async record(request: CommandRequest, result?: Pick<CommandResult, "exitCode" | "timedOut"> & Partial<Pick<CommandResult, "signal" | "descendantsHeldOutput" | "stdinFailed">> & { cancelled?: boolean; treeTerminated?: boolean }, error?: unknown): Promise<void> {
    await this.load();
    const command = commandPreview("command_run", request as unknown as Record<string, unknown>);
    const directory = contextSummary({ cwd: request.cwd }).directory;
    const complete = !!result && result.exitCode !== null && !result.timedOut && !result.signal && !result.descendantsHeldOutput && !result.stdinFailed && !result.cancelled && result.treeTerminated !== false;
    const succeeded = complete && result.exitCode === 0;
    const errorCode = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof Error ? error.message : "";
    const code = succeeded ? null : result?.timedOut ? "TIMED_OUT" : result && !complete ? "INCOMPLETE" :
      errorCode === "ENOENT" || errorCode === "COMMAND_NOT_FOUND" ? "NOT_FOUND" : message.includes("is not allowed") || errorCode === "COMMAND_NOT_ALLOWED" || errorCode === "LOCAL_PERMISSION_REQUIRED" ? "NOT_ALLOWED" : result ? "EXIT_NONZERO" : "COMMAND_ERROR";
    const id = createHash("sha256").update(command + "\n" + (directory ?? "") + "\n" + (succeeded ? "succeeded" : "failed")).digest("hex").slice(0, 16);
    const old = this.entries.find(e => e.id === id);
    this.entries = this.entries.filter(e => e.id !== id);
    this.entries.push({ id, command, directory, outcome: succeeded ? "succeeded" : "failed", code,
      exitCode: result?.exitCode ?? null, at: Date.now(), count: Math.min(1_000_000, (old?.count ?? 0) + 1) });
    this.entries = this.entries.slice(-32);
    // ponytail: one compact file for this personal server; multi-process writers need a broker.
    const encoded = JSON.stringify({ version: 1, platform: process.platform, entries: this.entries }) + "\n";
    this.writing = this.writing.then(async () => {
      const directory = path.dirname(this.file), temp = this.file + "." + process.pid + ".tmp";
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("HOST_MEMORY_DIRECTORY_INVALID");
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(encoded); await file.close(); await rename(temp, this.file); }
      finally { await file.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
    }).catch(() => { this.errors++; });
    // Diagnostic persistence is outside command latency and never changes its result.
  }
}
