import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

function fixture(t: TestContext) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/stdio-conformance-server.mjs", import.meta.url))], {
    windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env
  });
  const changed = new EventEmitter();
  let stdout = "", stderr = "";
  let spawnError: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; changed.emit("change"); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; changed.emit("change"); });
  child.on("error", (error) => { spawnError = error; changed.emit("change"); });
  const closed = once(child, "close");
  // Keep cleanup responsible for spawn errors too; awaiting closed still reports them.
  void closed.catch(() => {});
  t.after(async () => {
    child.stdin.end();
    const graceful = await Promise.race([closed.then(() => true, () => true), delay(1000, false, { ref: false })]);
    if (!graceful) {
      child.kill(); // Only this fixture's Node child, which launches no descendants.
      await Promise.race([closed, delay(3000, undefined, { ref: false }).then(() => { throw new Error("fixture cleanup timed out"); })]);
    }
  });
  const messages = () => stdout.replace(/\n$/, "").split("\n").map((line) => {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0", "every stdout line must be JSON-RPC");
    assert.ok("method" in message || "result" in message || "error" in message);
    return message;
  });
  async function until(check: () => boolean) {
    const signal = AbortSignal.timeout(5000);
    while (!check()) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `fixture exited early: ${stderr}`);
      await once(changed, "change", { signal });
    }
  }
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  async function response(id: number) {
    await until(() => stdout.endsWith("\n") && messages().some((message) => message.id === id));
    return messages().find((message) => message.id === id);
  }
  async function initialize() {
    await until(() => stderr.includes("fixture-ready\n"));
    send({ id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-wire-test", version: "0.0.0" }
    } });
    const initialized = await response(1);
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    assert.equal(initialized.result.serverInfo.name, "stdio-conformance");
    send({ method: "notifications/initialized" });
  }
  return { child, closed, send, response, initialize, messages, until, stderr: () => stderr, stdout: () => stdout };
}

test("stdio SDK exchanges raw frames, split UTF-8 and cancellation without stdout diagnostics", { timeout: 15000 }, async (t) => {
  const wire = fixture(t);
  await wire.initialize();
  wire.send({ id: 2, method: "tools/list" });
  assert.deepEqual((await wire.response(2)).result.tools.map((tool: { name: string }) => tool.name).sort(), ["echo", "wait"]);

  const text = "שלום 😀\nsecond line";
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text } } }) + "\n");
  const split = frame.indexOf(Buffer.from("😀")) + 1;
  const chunksBefore = wire.stderr().split("input-chunk\n").length;
  wire.child.stdin.write(frame.subarray(0, split));
  await wire.until(() => wire.stderr().split("input-chunk\n").length > chunksBefore);
  assert.ok(!wire.messages().some((message) => message.id === 3), "an incomplete frame cannot be dispatched");
  // A ping confirms the server remains usable after the rest of the frame arrives.
  wire.child.stdin.write(Buffer.concat([frame.subarray(split), Buffer.from('{"jsonrpc":"2.0","id":4,"method":"ping"}\n')]));
  assert.equal((await wire.response(3)).result.content[0].text, text);
  assert.deepEqual((await wire.response(4)).result, {});

  wire.send({ id: 5, method: "tools/call", params: { name: "wait", arguments: {} } });
  await wire.until(() => wire.stderr().includes("wait-started\n"));
  wire.send({ method: "notifications/cancelled", params: { requestId: 5, reason: "synthetic cancellation" } });
  await wire.until(() => wire.stderr().includes("wait-aborted\n"));
  wire.send({ id: 6, method: "ping" });
  assert.deepEqual((await wire.response(6)).result, {});
  wire.child.stdin.end();
  assert.deepEqual(await wire.closed, [0, null]);
  assert.ok(wire.stdout().endsWith("\n"));
  assert.deepEqual(wire.messages().map((message) => message.id).sort(), [1, 2, 3, 4, 6]);
  assert.doesNotMatch(wire.stderr(), /transport-error/);
});

test("stdio SDK aborts pending work and exits on stdin EOF", { timeout: 15000 }, async (t) => {
  const wire = fixture(t);
  await wire.initialize();
  wire.send({ id: 2, method: "tools/call", params: { name: "wait", arguments: {} } });
  await wire.until(() => wire.stderr().includes("wait-started\n"));
  wire.child.stdin.end();
  assert.deepEqual(await wire.closed, [0, null]);
  assert.match(wire.stderr(), /wait-aborted\n/);
  assert.deepEqual(wire.messages().map((message) => message.id), [1]);
  assert.doesNotMatch(wire.stderr(), /transport-error/);
});
