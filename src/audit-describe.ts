// Human-readable one-line descriptions of tool calls for the server console.
// Console only: the audit file keeps its structured, sanitized records.

export interface CallDescription {
  /** Short noun phrase, readable before and after the call ("Search "x" in D:/repo"). */
  text: string;
  /** True for tools that can run long enough that a "started" line helps the user. */
  announceStart: boolean;
}

const MAX_PATH = 70;
const MAX_TEXT = 48;

const TOOL_LABELS: Record<string, string> = {
  scheduler_status: "Check scheduler status",
  project_snapshot: "Project overview",
  fs_search: "Search files",
  fs_read: "Read file",
  fs_list: "List folder",
  fs_replace: "Edit file",
  fs_write: "Write file",
  git_status: "Git status",
  git_diff: "Git diff",
  git_log: "Git log",
  command_run: "Run command",
  parallel_command_run: "Run commands in parallel",
  process_start: "Start process"
};

const ANNOUNCED = new Set(["command_run", "parallel_command_run", "fs_search", "process_start"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clip(value: string, max = MAX_TEXT): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized.length <= MAX_PATH) return normalized;
  const parts = normalized.split("/");
  return `${parts[0]}/…/${parts.slice(-3).join("/")}`;
}

export function humanTimeout(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function commandText(meta: Record<string, unknown>): string {
  const command = str(meta.command) ?? "command";
  const where = str(meta.cwd);
  const limit = humanTimeout(meta.timeoutMs);
  const label = str(meta.id);
  const parts = [label && meta.batchParentRequestId !== undefined ? `[${clip(label, 24)}] ` : "", command];
  if (where) parts.push(` in ${shortPath(where)}`);
  if (limit) parts.push(`, limit ${limit}`);
  return parts.join("");
}

/**
 * `redact` is applied to any user-supplied free text (search queries, labels) before it is shown.
 * Command arguments are never printed.
 */
export function describeCall(tool: string, meta: Record<string, unknown>, redact: (text: string) => string): CallDescription {
  const label = TOOL_LABELS[tool] ?? tool.replaceAll("_", " ");
  const announceStart = ANNOUNCED.has(tool);
  const path = str(meta.path);
  let text = label;

  switch (tool) {
    case "fs_search": {
      const query = str(meta.query);
      const types = Array.isArray(meta.extensions) && meta.extensions.length ? ` [${meta.extensions.join(", ")} files]` : "";
      text = `${label}: "${query ? redact(clip(query)) : "?"}"${path ? ` in ${shortPath(path)}` : ""}${types}`;
      break;
    }
    case "fs_read": {
      const lines = typeof meta.startLine === "number" && typeof meta.endLine === "number" ? ` (lines ${meta.startLine}-${meta.endLine})` : "";
      text = `${label}: ${path ? shortPath(path) : "?"}${lines}`;
      break;
    }
    case "command_run":
      text = `${label}: ${commandText(meta)}`;
      break;
    case "parallel_command_run": {
      const commands = Array.isArray(meta.commands) ? meta.commands : [];
      const names = commands.map((c, i) => (c && typeof c === "object" && str((c as Record<string, unknown>).id)) || String(i + 1));
      text = `Run ${plural(commands.length, "command")} in parallel${names.length ? `: ${clip(names.join(", "), 60)}` : ""}`;
      break;
    }
    case "git_diff":
      text = `${label}${meta.staged ? " (staged)" : ""}: ${path ? shortPath(path) : "?"}`;
      break;
    default:
      if (path) text = `${label}: ${shortPath(path)}`;
  }

  // Sub-commands of a parallel batch are shown indented under their parent.
  if (tool === "command_run" && meta.batchParentRequestId !== undefined) text = `↳ ${text}`;
  return { text, announceStart };
}
