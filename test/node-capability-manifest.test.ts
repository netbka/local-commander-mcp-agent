import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeCapabilityManifest, localNodePlatform, NodeCapabilityFactsSchema, type NodeCapabilityFacts } from "../src/node-capability-manifest.js";

const lifecycle = { spawn: true, resume: true, status: true, cancel: true, message: true, interactiveOnly: false };
const facts = (): NodeCapabilityFacts => ({
  ...localNodePlatform(),
  actionClasses: ["git", "files", "git"],
  workspaces: [
    { id: "ws-b", locality: "synced" as const, traits: ["typescript", "git"] },
    { id: "ws-a", locality: "local" as const, traits: ["git"] }
  ],
  runtimeAdapters: [
    { name: "claude", lifecycle, modelClasses: ["reasoning", "coding"] },
    { name: "local", lifecycle: { ...lifecycle, interactiveOnly: true, spawn: false }, modelClasses: ["coding"] }
  ],
  load: { cpu: "low" as const, memory: "medium" as const, gpu: "unavailable" as const }
});

test("manifest hash is deterministic across ordering and observation time", () => {
  const a = buildNodeCapabilityManifest(facts(), { observedAt: 1000 });
  const reordered = facts();
  reordered.actionClasses.reverse();
  reordered.workspaces.reverse();
  reordered.runtimeAdapters.reverse();
  reordered.runtimeAdapters[1]!.modelClasses.reverse();
  const b = buildNodeCapabilityManifest(reordered, { previous: a, observedAt: 2000 });
  assert.equal(a.hash, b.hash);
  assert.equal(b.revision, a.revision);
  assert.notEqual(a.observedAt, b.observedAt);
  assert.deepEqual(a.facts, b.facts);
});

test("changed routing fact changes hash and advances revision", () => {
  const a = buildNodeCapabilityManifest(facts(), { observedAt: 1000 });
  const changed = facts();
  changed.load.cpu = "high";
  const b = buildNodeCapabilityManifest(changed, { previous: a, observedAt: 2000 });
  assert.notEqual(a.hash, b.hash);
  assert.equal(b.revision, a.revision + 1);
});

test("strict bounded schema rejects secret, environment and arbitrary inventory fields", () => {
  assert.throws(() => NodeCapabilityFactsSchema.parse({ ...facts(), providerToken: "secret" }));
  assert.throws(() => NodeCapabilityFactsSchema.parse({ ...facts(), env: { PATH: "x" } }));
  assert.throws(() => NodeCapabilityFactsSchema.parse({ ...facts(), installedSoftware: ["everything"] }));
  const tooMany = facts();
  tooMany.actionClasses = Array.from({ length: 65 }, (_, index) => "action-" + index);
  assert.throws(() => NodeCapabilityFactsSchema.parse(tooMany));
});

test("manifest contains routing facts, not permission authority", () => {
  const manifest = buildNodeCapabilityManifest(facts(), { observedAt: 1000 });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("permission"), false);
  assert.equal(serialized.includes("allow"), false);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.revision, 1);
});
