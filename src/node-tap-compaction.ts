// Native-runtime copy of packages/optimization/src/parser-contract.ts and
// packages/optimization/src/parsers/node-tap.ts. tsconfig.json builds src/ with
// rootDir "src", so the personal runtime cannot import packages/.
// test/native-output-compaction.test.ts keeps both copies behavior-identical.

export interface ShadowCommandCapture {
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export type ParserFallbackReason =
  | "unsupported_command"
  | "exit_not_zero"
  | "timeout_or_signal"
  | "source_truncated"
  | "stderr_present"
  | "unrecognized_format"
  | "unsupported_tap_version"
  | "failure_record"
  | "unrecognized_record"
  | "summary_missing"
  | "summary_inconsistent"
  | "ansi_or_control"
  | "candidate_not_smaller";

export interface NodeTapSummary {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  durationMs: number;
}

export interface ShadowPassThrough {
  state: "pass_through";
  parserId: string;
  parserVersion: string;
  recognized: boolean;
  completeSource: boolean;
  fidelity: "exact";
  fallbackReason: ParserFallbackReason;
  originalStdoutBytes: number;
  candidateStdoutBytes: null;
  candidateStdout: null;
  summary: null;
  notices: readonly string[];
}

export interface ShadowCompactCandidate {
  state: "candidate";
  parserId: string;
  parserVersion: string;
  recognized: true;
  completeSource: true;
  fidelity: "validated_compact";
  fallbackReason: null;
  originalStdoutBytes: number;
  candidateStdoutBytes: number;
  candidateStdout: string;
  summary: NodeTapSummary;
  notices: readonly string[];
}

export type ShadowParserResult = ShadowPassThrough | ShadowCompactCandidate;

export const NODE_TAP_PARSER_ID = "node-tap" as const;
export const NODE_TAP_PARSER_VERSION = "1" as const;
export const NODE_TAP_FAILURE_PARSER_ID = "node-tap-failure" as const;
export const NODE_TAP_FAILURE_PARSER_VERSION = "1" as const;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TAP_VERSION = /^TAP version (\d+)$/u;
const SUBTEST = /^# Subtest: (.+)$/u;
const OK = /^ok (\d+) - (.+)$/u;
const NOT_OK = /^not ok\b/u;
const PLAN = /^1\.\.(\d+)$/u;
const YAML_DURATION = /^  duration_ms: (\d+(?:\.\d+)?)$/u;
const YAML_TYPE = /^  type: ['"]test['"]$/u;
const SUMMARY_COUNT = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/u;
const SUMMARY_DURATION = /^# duration_ms (\d+(?:\.\d+)?)$/u;

type CountKey = "tests" | "suites" | "pass" | "fail" | "cancelled" | "skipped" | "todo";
const COUNT_KEYS: readonly CountKey[] = [
  "tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"
];

function normalizedCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\.(?:exe|cmd|bat)$/iu, "");
}

function supportedCommand(input: ShadowCommandCapture): boolean {
  const command = normalizedCommand(input.command);
  if (command === "node") return input.args.includes("--test");
  if (command !== "npm") return false;
  if (input.args[0] === "test") return true;
  return input.args[0] === "run" && input.args[1] === "test";
}

function passThrough(
  input: ShadowCommandCapture,
  reason: ParserFallbackReason,
  recognized: boolean,
  notices: readonly string[] = []
): ShadowPassThrough {
  return Object.freeze({
    state: "pass_through",
    parserId: NODE_TAP_PARSER_ID,
    parserVersion: NODE_TAP_PARSER_VERSION,
    recognized,
    completeSource: !input.stdoutTruncated && !input.stderrTruncated,
    fidelity: "exact",
    fallbackReason: reason,
    originalStdoutBytes: Buffer.byteLength(input.stdout, "utf8"),
    candidateStdoutBytes: null,
    candidateStdout: null,
    summary: null,
    notices: Object.freeze([...notices])
  });
}

function candidateText(summary: NodeTapSummary, notices: readonly string[]): string {
  const lines = [
    "PASS node-tap",
    `tests=${summary.tests} suites=${summary.suites} pass=${summary.pass} fail=${summary.fail} cancelled=${summary.cancelled} skipped=${summary.skipped} todo=${summary.todo}`,
    `duration_ms=${summary.durationMs}`
  ];
  if (notices.length > 0) {
    lines.push("notices:");
    lines.push(...notices);
  }
  return lines.join("\n") + "\n";
}

export function parseNodeTapShadow(input: ShadowCommandCapture): ShadowParserResult {
  if (!supportedCommand(input)) return passThrough(input, "unsupported_command", false);
  if (input.timedOut || input.signal !== null) return passThrough(input, "timeout_or_signal", true);
  if (input.stdoutTruncated || input.stderrTruncated) return passThrough(input, "source_truncated", true);
  if (input.exitCode !== 0) return passThrough(input, "exit_not_zero", true);
  if (Buffer.byteLength(input.stderr, "utf8") > 0) return passThrough(input, "stderr_present", true);
  if (CONTROL.test(input.stdout) || input.stdout.includes("\u001b")) return passThrough(input, "ansi_or_control", true);

  const lines = input.stdout.split(/\r?\n/u);
  const versionIndexes = lines
    .map((line, index) => TAP_VERSION.test(line) ? index : -1)
    .filter(index => index >= 0);
  if (versionIndexes.length !== 1) return passThrough(input, "unrecognized_format", true);

  const tapIndex = versionIndexes[0]!;
  const versionMatch = TAP_VERSION.exec(lines[tapIndex]!);
  if (!versionMatch) return passThrough(input, "unrecognized_format", true);
  if (versionMatch[1] !== "13") return passThrough(input, "unsupported_tap_version", true);

  const notices: string[] = lines.slice(0, tapIndex).filter(line => line.length > 0);
  let state: "between" | "expect-ok" | "expect-yaml" | "yaml" | "summary" = "between";
  let pendingTitle = "";
  let nextOkIndex = 1;
  let subtests = 0;
  let okRecords = 0;
  let yamlDurationSeen = false;
  let yamlTypeSeen = false;
  let planCount: number | null = null;
  const counts = new Map<CountKey, number>();
  let durationMs: number | null = null;

  for (let index = tapIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (CONTROL.test(line) || line.includes("\u001b")) return passThrough(input, "ansi_or_control", true, notices);

    if (state === "expect-ok") {
      if (NOT_OK.test(line)) return passThrough(input, "failure_record", true, notices);
      const match = OK.exec(line);
      if (!match) return passThrough(input, "unrecognized_record", true, notices);
      const recordIndex = Number(match[1]);
      if (recordIndex !== nextOkIndex || match[2] !== pendingTitle) {
        return passThrough(input, "summary_inconsistent", true, notices);
      }
      nextOkIndex += 1;
      okRecords += 1;
      state = "expect-yaml";
      continue;
    }

    if (state === "expect-yaml") {
      if (line !== "  ---") return passThrough(input, "unrecognized_record", true, notices);
      yamlDurationSeen = false;
      yamlTypeSeen = false;
      state = "yaml";
      continue;
    }

    if (state === "yaml") {
      if (line === "  ...") {
        if (!yamlDurationSeen || !yamlTypeSeen) return passThrough(input, "unrecognized_record", true, notices);
        state = "between";
        pendingTitle = "";
        continue;
      }
      const duration = YAML_DURATION.exec(line);
      if (duration) {
        if (yamlDurationSeen) return passThrough(input, "unrecognized_record", true, notices);
        yamlDurationSeen = true;
        continue;
      }
      if (YAML_TYPE.test(line)) {
        if (yamlTypeSeen) return passThrough(input, "unrecognized_record", true, notices);
        yamlTypeSeen = true;
        continue;
      }
      return passThrough(input, "unrecognized_record", true, notices);
    }

    if (state === "between") {
      if (line === "") continue;
      if (NOT_OK.test(line)) return passThrough(input, "failure_record", true, notices);

      const subtest = SUBTEST.exec(line);
      if (subtest) {
        pendingTitle = subtest[1]!;
        subtests += 1;
        state = "expect-ok";
        continue;
      }

      const plan = PLAN.exec(line);
      if (plan) {
        if (planCount !== null) return passThrough(input, "unrecognized_record", true, notices);
        planCount = Number(plan[1]);
        state = "summary";
        continue;
      }

      if (line.startsWith("# ")) {
        notices.push(line);
        continue;
      }

      return passThrough(input, "unrecognized_record", true, notices);
    }

    // summary
    if (line === "") continue;
    const count = SUMMARY_COUNT.exec(line);
    if (count) {
      const key = count[1] as CountKey;
      if (counts.has(key)) return passThrough(input, "summary_inconsistent", true, notices);
      counts.set(key, Number(count[2]));
      continue;
    }
    const summaryDuration = SUMMARY_DURATION.exec(line);
    if (summaryDuration) {
      if (durationMs !== null) return passThrough(input, "summary_inconsistent", true, notices);
      durationMs = Number(summaryDuration[1]);
      continue;
    }
    if (line.startsWith("# ")) {
      notices.push(line);
      continue;
    }
    if (NOT_OK.test(line)) return passThrough(input, "failure_record", true, notices);
    return passThrough(input, "unrecognized_record", true, notices);
  }

  if (state !== "summary" || planCount === null || durationMs === null) {
    return passThrough(input, "summary_missing", true, notices);
  }
  if (COUNT_KEYS.some(key => !counts.has(key))) return passThrough(input, "summary_missing", true, notices);

  const summary: NodeTapSummary = {
    tests: counts.get("tests")!,
    suites: counts.get("suites")!,
    pass: counts.get("pass")!,
    fail: counts.get("fail")!,
    cancelled: counts.get("cancelled")!,
    skipped: counts.get("skipped")!,
    todo: counts.get("todo")!,
    durationMs
  };

  const clean =
    summary.tests > 0 &&
    summary.suites === 0 &&
    summary.pass === summary.tests &&
    summary.fail === 0 &&
    summary.cancelled === 0 &&
    summary.skipped === 0 &&
    summary.todo === 0 &&
    planCount === summary.tests &&
    subtests === summary.tests &&
    okRecords === summary.tests &&
    nextOkIndex === summary.tests + 1;

  if (!clean) return passThrough(input, "summary_inconsistent", true, notices);

  const shadow = candidateText(summary, notices);
  const originalStdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const candidateStdoutBytes = Buffer.byteLength(shadow, "utf8");
  if (candidateStdoutBytes >= originalStdoutBytes) {
    return passThrough(input, "candidate_not_smaller", true, notices);
  }

  return Object.freeze({
    state: "candidate",
    parserId: NODE_TAP_PARSER_ID,
    parserVersion: NODE_TAP_PARSER_VERSION,
    recognized: true,
    completeSource: true,
    fidelity: "validated_compact",
    fallbackReason: null,
    originalStdoutBytes,
    candidateStdoutBytes,
    candidateStdout: shadow,
    summary: Object.freeze(summary),
    notices: Object.freeze([...notices])
  });
}

// Failure output is a separate shadow parser: the clean-success v1 contract stays unchanged.
export function parseNodeTapFailureShadow(input: ShadowCommandCapture): ShadowParserResult {
  const fallback = (reason: ParserFallbackReason, recognized = true): ShadowPassThrough => ({
    ...passThrough(input, reason, recognized),
    parserId: NODE_TAP_FAILURE_PARSER_ID,
    parserVersion: NODE_TAP_FAILURE_PARSER_VERSION
  });
  if (!supportedCommand(input)) return fallback("unsupported_command", false);
  if (input.timedOut || input.signal !== null) return fallback("timeout_or_signal");
  if (input.stdoutTruncated || input.stderrTruncated) return fallback("source_truncated");
  if (input.exitCode === 0) return fallback("unrecognized_format");
  if (input.exitCode === null) return fallback("exit_not_zero");
  if (input.stderr) return fallback("stderr_present");
  if (CONTROL.test(input.stdout) || input.stdout.includes("\u001b")) return fallback("ansi_or_control");
  if (input.stdout.includes("\r") || !input.stdout.endsWith("\n")) return fallback("unrecognized_format");

  const lines = input.stdout.split("\n");
  const versions = lines.flatMap((line, index) => TAP_VERSION.test(line) ? [index] : []);
  if (versions.length !== 1) return fallback("unrecognized_format");
  const tapIndex = versions[0]!;
  if (lines[tapIndex] !== "TAP version 13") return fallback("unsupported_tap_version");

  const kept = lines.slice(0, tapIndex + 1);
  const notices = lines.slice(0, tapIndex).filter(Boolean);
  let index = tapIndex + 1;
  let passed = 0;
  let failed = 0;
  while (index < lines.length && !PLAN.test(lines[index]!)) {
    const line = lines[index]!;
    if (!line || (line.startsWith("# ") && !SUBTEST.test(line))) {
      kept.push(line);
      if (line) notices.push(line);
      index++;
      continue;
    }
    const title = SUBTEST.exec(line)?.[1];
    const record = /^(ok|not ok) (\d+) - (.+)$/u.exec(lines[index + 1] ?? "");
    if (!title || !record || record[3] !== title || Number(record[2]) !== passed + failed + 1) {
      return fallback("unrecognized_record");
    }
    if (lines[index + 2] !== "  ---") return fallback("unrecognized_record");
    const end = lines.indexOf("  ...", index + 3);
    if (end < 0 || lines.slice(index + 3, end).some(item => !item.startsWith("  "))) {
      return fallback("unrecognized_record");
    }
    const yaml = lines.slice(index + 3, end);
    if (record[1] === "ok") {
      if (yaml.length !== 2 || !YAML_DURATION.test(yaml[0]!) || !YAML_TYPE.test(yaml[1]!)) {
        return fallback("unrecognized_record");
      }
      passed++;
    } else {
      if (yaml.length === 0) return fallback("unrecognized_record");
      failed++;
      kept.push(...lines.slice(index, end + 1));
    }
    index = end + 1;
  }

  const plan = PLAN.exec(lines[index] ?? "");
  if (!plan) return fallback("summary_missing");
  const counts = new Map<CountKey, number>();
  let durationMs: number | null = null;
  for (const line of lines.slice(index + 1)) {
    if (!line) continue;
    const count = SUMMARY_COUNT.exec(line);
    if (count) {
      const key = count[1] as CountKey;
      if (counts.has(key)) return fallback("summary_inconsistent");
      counts.set(key, Number(count[2]));
    } else {
      const duration = SUMMARY_DURATION.exec(line);
      if (duration) {
        if (durationMs !== null) return fallback("summary_inconsistent");
        durationMs = Number(duration[1]);
      } else if (line.startsWith("# ")) {
        notices.push(line);
      } else {
        return fallback("unrecognized_record");
      }
    }
  }
  if (COUNT_KEYS.some(key => !counts.has(key)) || durationMs === null) return fallback("summary_missing");
  if (!Number.isFinite(durationMs)) return fallback("summary_inconsistent");
  const summary: NodeTapSummary = {
    tests: counts.get("tests")!, suites: counts.get("suites")!, pass: counts.get("pass")!,
    fail: counts.get("fail")!, cancelled: counts.get("cancelled")!,
    skipped: counts.get("skipped")!, todo: counts.get("todo")!, durationMs
  };
  if (
    !failed || Number(plan[1]) !== passed + failed ||
    summary.tests !== passed + failed || summary.pass !== passed || summary.fail !== failed ||
    summary.suites !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0
  ) return fallback("summary_inconsistent");
  if (!passed) return fallback("candidate_not_smaller");

  kept.push(`# shadow-omitted-successes ${passed}`, ...lines.slice(index));
  const candidateStdout = kept.join("\n");
  const originalStdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const candidateStdoutBytes = Buffer.byteLength(candidateStdout, "utf8");
  if (candidateStdoutBytes >= originalStdoutBytes) return fallback("candidate_not_smaller");
  return Object.freeze({
    state: "candidate", parserId: NODE_TAP_FAILURE_PARSER_ID,
    parserVersion: NODE_TAP_FAILURE_PARSER_VERSION, recognized: true,
    completeSource: true, fidelity: "validated_compact", fallbackReason: null,
    originalStdoutBytes, candidateStdoutBytes, candidateStdout,
    summary: Object.freeze(summary), notices: Object.freeze(notices)
  });
}
