import { createHash } from "node:crypto";

// Transliteration keeps terminal widths predictable. Random runtime IDs select the pool without a model or handshake.
export const AGENT_NAMES = Object.freeze([
  "Avi", "Noam", "Yael", "Leah", "Ezra", "Eli", "Tamar", "Dalia", "Ruth", "Maya", "Oren", "Shira", "Eitan", "Lior", "Hila", "Amir",
  "Ivan", "Yuri", "Olga", "Anna", "Boris", "Nina", "Pavel", "Irina", "Vera", "Daria", "Misha", "Sasha", "Vadim", "Roman", "Anya", "Lev",
  "Omar", "Layla", "Ali", "Nadia", "Salim", "Hana", "Rami", "Zain", "Noor", "Amal", "Samir", "Farah", "Malik", "Yasmin", "Adil", "Hadi",
  "Arjun", "Priya", "Ravi", "Anika", "Asha", "Dev", "Kiran", "Meera", "Nisha", "Rohan", "Diya", "Neha", "Anil", "Sana", "Vijay", "Isha",
  "Wei", "Lin", "Mei", "Chen", "Li", "Jian", "Ming", "Hua", "Yan", "Tao", "Jun", "Lan", "Yue", "Lei", "Hong", "Qian",
  "Pickle", "Waffle", "Noodle", "Spud", "Mochi", "Taco", "Doodle", "Widget", "Boop", "Bytey", "Glitch", "Sprock", "Wombat", "Goose", "Ninja", "Otter", "Quokka", "Squid", "Sushi", "Pogo", "Zippy", "Nifty", "Fuzzy", "Gizmo", "Bloop", "Blip", "Niblet", "Pixel", "Bugsy", "Wobble", "Muppet", "Puddle", "Cookie", "Muffin", "Bagel", "Nacho", "Tater", "Churro", "Snappy", "Peppy", "Plonk", "Slinky", "Tofu", "Nugget", "Dumplo", "Popper", "Kebab", "Sizzle"
]);
export function agentName(id) {
  const hash = createHash("sha256").update(id).digest();
  return AGENT_NAMES[hash.readUInt16BE(0) % AGENT_NAMES.length] + hash.subarray(2, 3).toString("hex");
}
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
export function contextSummary(meta = {}) {
  const source = typeof (meta.cwd ?? meta.path ?? meta.project) === "string" ? (meta.cwd ?? meta.path ?? meta.project) : "";
  const normalized = source.replaceAll("\\", "/").replace(/\/+$/, "");
  const safe = normalized.length <= 1024 && /^[A-Za-z0-9 _./:@()+-]*$/.test(normalized) &&
    !/(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials[^/]*|\.npmrc|agent-identities\.json)(?:\/|$)/i.test(normalized);
  const directory = safe && normalized ? normalized.slice(-96) : null;
  const project = directory ? directory.split("/").at(-1) : null;
  const taskMatch = safe && normalized.match(/\/planning\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,95})\.md$/);
  const taskId = identifier(meta.taskId) ? meta.taskId : taskMatch ? taskMatch[1] : null;
  const branchPr = safe && normalized.match(/(?:^|[/_-])pr[-_]?(\d{1,7})(?:[/_.-]|$)/i);
  const explicitPr = Number.isSafeInteger(meta.pr) && meta.pr > 0 && meta.pr <= 9_999_999 ? meta.pr : null;
  const args = Array.isArray(meta.args) ? meta.args : [];
  const ghPr = meta.command === "gh" && args[0] === "pr" && ["view", "checkout", "diff", "checks", "merge"].includes(args[1]) && /^\d{1,7}$/.test(args[2] ?? "") ? Number(args[2]) : null;
  return { project, directory, taskId, pr: explicitPr ?? ghPr ?? (branchPr ? Number(branchPr[1]) : null), inferred: !explicitPr && !identifier(meta.taskId) };
}
export function commandSummary(tool, meta = {}) {
  if (tool === "agent_message" && ["send", "inbox", "ack"].includes(meta.action)) {
    const kind = ["status", "question", "answer", "handoff", "result_summary", "blocker"].includes(meta.kind) ? " " + meta.kind : "";
    const target = identifier(meta.to) ? " -> " + meta.to.slice(0, 8) : "";
    return "agent_message " + meta.action + kind + target;
  }
  if (!["command_run", "process_start"].includes(tool)) return tool;
  const candidate = typeof meta.command === "string" ? meta.command.replaceAll("\\", "/").split("/").at(-1).replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase() : "";
  const name = ["node", "npm", "npx", "git", "rg", "powershell", "pwsh", "cmd", "tsc", "python", "dotnet", "gh"].includes(candidate) ? candidate : "command";
  const args = Array.isArray(meta.args) ? meta.args : [];
  if (name === "git" && ["status", "diff", "log", "show", "fetch", "pull", "push", "commit"].includes(args[0])) return name + " " + args[0];
  if (name === "npm" && ["test", "install", "ci", "pack", "publish"].includes(args[0])) return name + " " + args[0];
  if (name === "npm" && args[0] === "run" && ["test", "build", "typecheck", "lint", "dev", "start"].includes(args[1])) return "npm run " + args[1];
  return name + (args.length ? " [args]" : "");
}

/** Diagnostic preview only. Never used to construct or execute a command. */
export function commandPreview(tool, meta = {}) {
  if (!["command_run", "process_start"].includes(tool)) return commandSummary(tool, meta);
  const name = typeof meta.command === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(meta.command) ? meta.command : "command";
  const args = Array.isArray(meta.args) ? meta.args.slice(0, 24) : [];
  let hideNext = false, inline = false;
  const safe = args.map(arg => {
    if (inline || hideNext) { hideNext = false; return "[redacted]"; }
    if (typeof arg !== "string") return "[value]";
    if (/^(?:-e|--eval|-p|--print|-c|-command|--command|-encodedcommand|\/c|\/k)$/i.test(arg) &&
        /^(?:node|python|bash|sh|powershell|pwsh|cmd)(?:\.[a-z]+)?$/i.test(name)) inline = true;
    if (/^(?:[-/]+(?:.*(?:token|password|passwd|secret|credential|authorization|api[-_]?key)|auth|key|header|env|config|data|data-raw|data-binary|message|prompt)|-[uHpmd])$/i.test(arg)) hideNext = true;
    if (/(?:token|password|passwd|secret|credential|authorization|api[-_]?key)\s*[=:]|(?:^|[/\\])(?:\.env(?:\.|$)|credentials|\.npmrc)|:\/\/|[\x00-\x1f\x7f]|[A-Za-z0-9+/_=-]{40,}/i.test(arg)) return "[redacted]";
    // ponytail: printable simple argv only; embedded scripts and complex values stay private.
    return arg.length <= 96 && /^[A-Za-z0-9 _./\\:@()+=-]+$/.test(arg) ? (arg.includes(" ") ? JSON.stringify(arg) : arg) : "[value]";
  });
  return [name, ...safe, ...(Array.isArray(meta.args) && meta.args.length > 24 ? ["…"] : [])].join(" ").slice(0, 240);
}
