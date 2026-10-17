import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntimeIdentityStore } from "../src/agent-runtime-identity.js";

test("runtime credentials are server-issued, persistent by hash and cannot impersonate peers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lc-runtime-id-"));
  const file = path.join(dir, "identity.json");
  let clock = 1_700_000_000_000;
  try {
    const store = new AgentRuntimeIdentityStore(file, () => clock);
    const a = await store.issue();
    const b = await store.issue();
    assert.notEqual(a.runtimeId, b.runtimeId);
    assert.notEqual(a.runtimeKey, b.runtimeKey);

    await store.authenticate(a.runtimeId, a.runtimeKey);
    await store.authenticate(b.runtimeId, b.runtimeKey);
    await assert.rejects(store.authenticate(a.runtimeId, b.runtimeKey), /RUNTIME_IDENTITY_DENIED/);
    await assert.rejects(store.authenticate(b.runtimeId, a.runtimeKey), /RUNTIME_IDENTITY_DENIED/);

    const persisted = await readFile(file, "utf8");
    assert.equal(persisted.includes(a.runtimeKey), false);
    assert.equal(persisted.includes(b.runtimeKey), false);

    clock += 1000;
    const reopened = new AgentRuntimeIdentityStore(file, () => clock);
    await reopened.authenticate(a.runtimeId, a.runtimeKey);
    await reopened.revoke(a.runtimeId, a.runtimeKey);
    await assert.rejects(reopened.authenticate(a.runtimeId, a.runtimeKey), /RUNTIME_IDENTITY_DENIED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed runtime credentials fail closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lc-runtime-id-"));
  try {
    const store = new AgentRuntimeIdentityStore(path.join(dir, "identity.json"));
    const a = await store.issue();
    await assert.rejects(store.authenticate(a.runtimeId, "not-a-key"), /RUNTIME_IDENTITY_INVALID/);
    await assert.rejects(store.authenticate("rt-not-a-uuid", a.runtimeKey), /RUNTIME_IDENTITY_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
