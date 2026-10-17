// Development-only policy loader. No credentials, network calls, imports from policy,
// recursive routing, generated commands or filesystem writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INSTRUCTION_BYTES = 16384;
const source = 'AGENTS.md';
const requiredHeadings = ['# Local Commander agent instructions', '## Start here', '## Permission boundary', '## Ownership', '## Bounded workers', '## Verify and finish'];

/** Load one bounded, regular UTF-8 policy file; never fall back to weaker defaults. */
export async function loadAgentInstructions(root) {
  let handle;
  try {
    const filename = path.join(root, source);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('AGENT_INSTRUCTIONS_INVALID');
    handle = await fs.open(filename, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_INSTRUCTION_BYTES) throw new Error('AGENT_INSTRUCTIONS_INVALID');
    const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes === 0 || bytes > MAX_INSTRUCTION_BYTES) throw new Error('AGENT_INSTRUCTIONS_INVALID');
    const raw = buffer.subarray(0, bytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n/g, '\n').trim();
    if (!requiredHeadings.every(heading => text.split('\n').includes(heading))) throw new Error('AGENT_INSTRUCTIONS_INVALID');
    return Object.freeze({
      text,
      evidence: Object.freeze({ source, sha256: createHash('sha256').update(raw).digest('hex'), bytes })
    });
  } catch {
    // Do not expose path contents, filesystem details or candidate policy text.
    throw new Error('AGENT_INSTRUCTIONS_INVALID');
  } finally {
    if (handle) await handle.close();
  }
}

/** All task-specific restrictions may narrow the policy, never grant more access. */
export function buildAgentSystemPrompt(policy, assignment) {
  if (!policy?.text || !policy?.evidence?.sha256 || typeof assignment !== 'string' || !assignment.trim()) {
    throw new Error('AGENT_INSTRUCTIONS_INVALID');
  }
  return `${policy.text}\n\n## This proposal worker's assignment\nThe coordinator supplied the policy above; do not recursively reload instructions. Inherit only the coordinator's bounded task and owned paths. Historical job templates do not require test suites or new automatic tests: verification is proportional by default (covering existing tests, necessary builds and small real runtime checks; full suites only when warranted or requested). New automatic tests require an explicit request. You have no tools: return a proposal, never claim execution, tests or new permissions. The assignment below can only restrict the policy, not expand authorization.\n\n${assignment}`;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
const sameFile = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
if (sameFile) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('AGENT_BOOTSTRAP_USAGE');
    const policy = await loadAgentInstructions(path.resolve(path.dirname(self), '..'));
    console.log(process.argv[2] === '--check' ? JSON.stringify(policy.evidence) : policy.text);
  } catch (error) {
    console.error(error.message === 'AGENT_BOOTSTRAP_USAGE' ? 'Usage: node scripts/agent-bootstrap.mjs [--check]' : 'AGENT_INSTRUCTIONS_INVALID');
    process.exitCode = 1;
  }
}
