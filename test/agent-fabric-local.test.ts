import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentFabric, parseFabricState, runtimeHealth } from "../src/agent-fabric-local.js";
import { renderAgentMonitor } from "../src/agent-monitor-page.js";

let clock = 1_700_000_000_000;
const now = () => clock;

async function withFabric(fn: (fabric: AgentFabric, file: string) => Promise<void>) {
  const parent = os.tmpdir();
  const directory = await mkdtemp(path.join(parent, "lc-fabric-test-"));
  assert.equal(path.dirname(directory), path.resolve(parent));
  clock = 1_700_000_000_000;
  try {
    // Mirrors the real protected server-state location.
    const file = path.join(directory, ".local-commander", "agents.json");
    await fn(new AgentFabric(file, now), file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const announce = (fabric: AgentFabric, label: string, node = "desk") =>
  fabric.announce({ label, source: "local_cli", node, leaseMs: 60_000 });

test("presence degrades by missed leases and never implies the work finished", async () => withFabric(async fabric => {
  const runtime = await announce(fabric, "cursor");
  assert.equal((await fabric.snapshot()).runtimes[0]!.health, "active");
  await fabric.report({ runtimeId: runtime, activity: "running tests", taskId: "LC-CTRL-01" });

  clock += 61_000;
  assert.equal((await fabric.snapshot()).runtimes[0]!.health, "stale");
  clock += 200_000;
  const lost = (await fabric.snapshot()).runtimes[0]!;
  assert.equal(lost.health, "lost");
  // A lost runtime keeps its task; losing contact is not a completion.
  assert.equal(lost.taskId, "LC-CTRL-01");
  assert.equal(lost.activity, "running tests");

  await fabric.report({ runtimeId: runtime, activity: "back" });
  assert.equal((await fabric.snapshot()).runtimes[0]!.health, "active");
  await fabric.report({ runtimeId: runtime, stopped: true });
  assert.equal((await fabric.snapshot()).runtimes[0]!.health, "stopped");
}));

test("re-announcing a known runtime refreshes presence instead of forking identity", async () => withFabric(async fabric => {
  const runtime = await announce(fabric, "codex");
  await fabric.report({ runtimeId: runtime, taskId: "LC-CTRL-01", activity: "implementing" });
  clock += 5_000;
  const again = await fabric.announce({ runtimeId: runtime, label: "codex", source: "local_cli", node: "desk" });
  assert.equal(again, runtime);
  const snapshot = await fabric.snapshot();
  assert.equal(snapshot.runtimes.length, 1);
  assert.equal(snapshot.runtimes[0]!.taskId, "LC-CTRL-01");
  await assert.rejects(fabric.report({ runtimeId: "rt-absent", activity: "x" }), /FABRIC_RUNTIME_UNKNOWN/);
}));

test("messages are addressed, idempotent and acknowledged once", async () => withFabric(async fabric => {
  const a = await announce(fabric, "coordinator");
  const b = await announce(fabric, "worker", "laptop");
  const sent = await fabric.send({ messageId: "m1", taskId: "LC-CTRL-01", from: a, to: b, kind: "handoff", body: "take the store lock repair" });
  assert.equal(await fabric.send({ messageId: "m1", taskId: "LC-CTRL-01", from: a, to: b, kind: "handoff", body: "take the store lock repair" }), sent);
  await assert.rejects(fabric.send({ messageId: "m1", taskId: "LC-CTRL-01", from: a, to: b, kind: "handoff", body: "different" }), /FABRIC_MESSAGE_ID_CONFLICT/);

  assert.equal((await fabric.inbox(a)).length, 0);
  assert.equal((await fabric.inbox(b)).length, 1);
  assert.equal((await fabric.snapshot()).runtimes.find(r => r.id === b)!.unreadCount, 1);
  assert.equal(await fabric.ack(b, "m1"), true);
  assert.equal((await fabric.inbox(b)).length, 0);
  assert.equal((await fabric.inbox(b, { includeAcked: true })).length, 1);
  // Only the addressee can acknowledge, and acknowledging twice is harmless.
  assert.equal(await fabric.ack(a, "m1"), false);
  assert.equal(await fabric.ack(b, "m1"), true);
}));

test("a role mailbox outlives the runtime that was meant to read it", async () => withFabric(async fabric => {
  const a = await announce(fabric, "coordinator");
  await fabric.send({ taskId: "LC-CTRL-01", from: a, to: "role:verifier", kind: "question", body: "ready?" });
  clock += 10 * 60_000;
  const later = await announce(fabric, "fresh-verifier", "laptop");
  assert.equal((await fabric.inbox("role:verifier")).length, 1);
  assert.equal((await fabric.inbox(later)).length, 0);
}));

test("expired messages are dropped and bounds reject oversized or unknown fields", async () => withFabric(async fabric => {
  const a = await announce(fabric, "coordinator");
  await fabric.send({ taskId: "t", from: a, to: a, kind: "status", body: "short lived", ttlMs: 30_000 });
  assert.equal((await fabric.inbox(a)).length, 1);
  clock += 31_000;
  assert.equal((await fabric.inbox(a)).length, 0);
  assert.equal((await fabric.snapshot()).messages.length, 0);

  await assert.rejects(fabric.send({ taskId: "t", from: a, to: a, kind: "status", body: "x".repeat(4001) }));
  await assert.rejects(fabric.announce({ label: "x".repeat(81), source: "local_cli", node: "desk" }));
  assert.throws(() => parseFabricState({ version: 1, runtimes: [], messages: [], secretToken: "x" }), /FABRIC_STATE_INVALID/);
  assert.throws(() => parseFabricState({ version: 2, runtimes: [], messages: [] }), /FABRIC_STATE_INVALID/);
}));

test("state survives reload, writes atomically and refuses a corrupt file", async () => withFabric(async (fabric, file) => {
  const runtime = await announce(fabric, "cursor");
  await fabric.report({ runtimeId: runtime, activity: "reviewing", taskId: "LC-CTRL-01" });
  await fabric.send({ messageId: "m1", taskId: "LC-CTRL-01", from: runtime, to: "role:owner", kind: "blocker", body: "needs approval" });

  const reopened = new AgentFabric(file, now);
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.runtimes[0]!.activity, "reviewing");
  assert.equal(snapshot.messages[0]!.body, "needs approval");
  // No temporary file is left behind by the atomic replace.
  assert.deepEqual(await readdir(path.dirname(file)), ["agents.json"]);

  await writeFile(file, "{not json");
  await assert.rejects(new AgentFabric(file, now).snapshot(), /FABRIC_STATE_CORRUPT/);
  assert.equal(await readFile(file, "utf8"), "{not json");
}));

test("the monitor page is self-contained and escapes hostile content", async () => withFabric(async fabric => {
  const runtime = await fabric.announce({ label: "<img src=x onerror=alert(1)>", source: "remote_web", node: "web" });
  await fabric.report({ runtimeId: runtime, activity: "</style><script>alert(2)</script>", taskId: "LC-CTRL-01" });
  await fabric.send({ taskId: "LC-CTRL-01", from: runtime, to: "role:owner", kind: "status", body: "<b>bold</b> & 'quoted'" });

  const html = renderAgentMonitor({
    snapshot: await fabric.snapshot(),
    tasks: [{ id: "LC-CTRL-01", status: "WORKING", assignee: runtime, attempts: 1, run: "LC-CTRL-01.1" }],
    refreshSeconds: 5
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; &#39;quoted&#39;/);
  // Hostile text must stay text, so only our own markup may produce real tags.
  const allowed = new Set(["html", "head", "meta", "title", "style", "body",
    "h1", "h2", "p", "table", "thead", "tbody", "tr", "th", "td", "span", "footer"]);
  const tags = [...html.matchAll(/<\/?([a-z0-9-]+)/gi)].map(match => match[1]!.toLowerCase());
  assert.deepEqual(tags.filter(tag => !allowed.has(tag)), []);
  // Nothing may be fetched: no external reference and no runtime script of our own.
  assert.equal(/@import|url\(|https?:\/\//i.test(html), false);
  assert.match(html, /<meta http-equiv="refresh" content="5">/);
  assert.match(html, /LC-CTRL-01\.1/);
  assert.equal(runtimeHealth({
    id: "rt", label: "x", source: "unknown", node: "n", capabilities: [], taskId: null,
    activity: null, stopped: false, registeredAt: 1, lastSeenAt: clock, leaseMs: 1000
  }, clock), "active");
}));
