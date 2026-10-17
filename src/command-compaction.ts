import { compactJsonOutput } from "../packages/optimization/src/operation-library.mjs";
import { parseNodeTapFailureShadow, parseNodeTapShadow } from "./node-tap-compaction.js";
import type { CommandResult } from "./process.js";

export interface CommandCompaction {
  result: CommandResult;
  savedStdoutBytes: number;
}

/**
 * Native counterpart of packages/optimization/src/live-result.ts. Only stdout of a complete
 * execution is replaced, and only by a fully validated, strictly smaller Node TAP candidate.
 * Status fields and stderr stay exact; anything else is returned unchanged with nothing saved.
 */
export function compactCommandResult(result: CommandResult): CommandCompaction {
  if (result.exitCode === null || result.timedOut || result.signal !== null || result.descendantsHeldOutput) {
    return { result, savedStdoutBytes: 0 };
  }
  const parsed = result.exitCode === 0 ? parseNodeTapShadow(result) : parseNodeTapFailureShadow(result);
  if (parsed.state !== "candidate" || parsed.candidateStdoutBytes >= parsed.originalStdoutBytes) {
    const compact = result.exitCode === 0 && !result.stdoutTruncated && !result.stderrTruncated && !result.stdinFailed && result.stderr === "" ? compactJsonOutput(result.stdout) : null;
    return compact === null ? { result, savedStdoutBytes: 0 } :
      { result: { ...result, stdout: compact }, savedStdoutBytes: Buffer.byteLength(result.stdout) - Buffer.byteLength(compact) };
  }
  return {
    result: { ...result, stdout: parsed.candidateStdout },
    savedStdoutBytes: parsed.originalStdoutBytes - parsed.candidateStdoutBytes
  };
}
