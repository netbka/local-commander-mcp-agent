import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../src/config.js';
import type { PathGuard } from '../src/guard.js';
import type { ProcessManager } from '../src/process.js';
import type { AuditLogger } from '../src/audit.js';
import { ExecutionScheduler } from '../src/scheduler.js';
import { registerTools } from '../src/tools.js';

type Registered = {
  config: { description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } };
  handler: (args: Record<string, unknown>, ctx?: { mcpReq: { signal: AbortSignal } }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};
function fixture(realScheduler?: ExecutionScheduler) {
  const tools = new Map<string, Registered>();
  let scheduled = 0;
  const controlled: string[] = [];
  const server = { registerTool(name: string, config: Registered['config'], handler: Registered['handler']) { tools.set(name, { config, handler }); } };
  const config = { auth: { mode: 'none' }, shell: { maxTimeoutMs: 240_000 } } as AppConfig;
  const audit = { start: async () => ({ id: 1, startedAt: Date.now() }), finish: async () => {}, fail: async () => {} };
  const scheduler = { run: () => { scheduled++; throw new Error('Execution capacity is exhausted'); }, snapshot: () => ({ active: 12, queued: 100 }) };
  const processes = {
    list: () => { controlled.push('list'); return []; },
    output: (id: string) => { controlled.push('output:' + id); return { output: 'tail' }; },
    kill: async (id: string) => { controlled.push('kill:' + id); return { killConfirmed: true }; }
  };
  registerTools(server as unknown as McpServer, config, {} as PathGuard, processes as unknown as ProcessManager, audit as unknown as AuditLogger, realScheduler ?? scheduler as unknown as ExecutionScheduler);
  return { tools, controlled, scheduled: () => scheduled };
}

test('arbitrary command tools advertise mutation and open-world effects', () => {
  const f = fixture();
  for (const name of ['command_run', 'parallel_command_run', 'process_start', 'localhost_request']) {
    const hints = f.tools.get(name)?.config.annotations;
    assert.equal(hints?.readOnlyHint, false, name);
    assert.equal(hints?.destructiveHint, true, name);
    assert.equal(hints?.openWorldHint, true, name);
  }
  assert.equal(f.tools.get('fs_read')?.config.annotations?.readOnlyHint, true);
});

test('command tools state the configured timeout cap and route long runs to process_start', () => {
  const f = fixture();
  const commandRun = f.tools.get('command_run')?.config.description ?? '';
  assert.match(commandRun, /capped at 240000 ms/);
  assert.match(commandRun, /timedOut/);
  assert.match(commandRun, /process_start/);
  assert.match(f.tools.get('parallel_command_run')?.config.description ?? '', /240000 ms/);
  const processStart = f.tools.get('process_start')?.config.description ?? '';
  assert.match(processStart, /no timeout/);
  assert.match(processStart, /closed stdin/);
});

test('status, bounded output and cancellation bypass saturated execution scheduling', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['process_list', {}],
    ['process_output', { id: 'owned-1', tailChars: 50 }],
    ['process_kill', { id: 'owned-1' }],
    ['scheduler_status', {}]
  ] as const) {
    const tool = f.tools.get(name);
    assert.ok(tool, name);
    const result = await tool.handler(args);
    assert.notEqual(result.isError, true, name);
  }
  assert.equal(f.scheduled(), 0);
  assert.deepEqual(f.controlled, ['list', 'output:owned-1', 'kill:owned-1']);
});

test('all scheduled tools honor sender cancellation and queued batch children never start', async () => {
  const scheduler = new ExecutionScheduler({ read: 1, general: 1, cpu: 1, wait: 1 });
  const f = fixture(scheduler);
  const controller = new AbortController();
  const ctx = { mcpReq: { signal: controller.signal } };
  controller.abort();
  const args = { path: 'same.txt', content: '', command: 'node', args: [], commands: [{ command: 'node', args: [] }, { command: 'node', args: [] }] };
  for (const name of ['fs_read', 'fs_list', 'fs_search', 'fs_write', 'fs_replace', 'git_status', 'git_diff', 'git_log',
    'command_run', 'parallel_command_run', 'process_start', 'localhost_request', 'project_snapshot']) {
    const result = await f.tools.get(name)!.handler(args, ctx);
    assert.equal(result.isError, true, name);
    assert.equal(result.content[0]!.text, 'CANCELLED_BEFORE_ACCEPTANCE', name);
  }

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = scheduler.run(99, 'command_run', { command: 'node' }, () => gate);
  const waiting = new AbortController();
  const waitingCtx = { mcpReq: { signal: waiting.signal } };
  const calls = [f.tools.get('command_run')!.handler(args, waitingCtx), f.tools.get('parallel_command_run')!.handler(args, waitingCtx)];
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((scheduler.snapshot().queued as unknown[]).length, 3);
    waiting.abort();
    const [single, batch] = await Promise.all(calls);
    assert.equal(single!.content[0]!.text, 'CANCELLED_BEFORE_ACCEPTANCE');
    const result = JSON.parse(batch!.content[0]!.text) as { failed: number; results: Array<{ error: string }> };
    assert.equal(result.failed, 2);
    assert.deepEqual(result.results.map(item => item.error), ['CANCELLED_BEFORE_ACCEPTANCE', 'CANCELLED_BEFORE_ACCEPTANCE']);
    assert.deepEqual(scheduler.snapshot().queued, []);
  } finally {
    waiting.abort();
    release();
    await Promise.all([active, ...calls]);
  }
});
