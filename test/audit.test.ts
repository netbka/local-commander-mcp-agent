import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger, sanitizeMeta } from "../src/audit.js";
import {
  auditRecoveryKeyId,
  decryptAuditRecord,
  encryptAuditRecord,
  generateAuditRecoveryKey,
  type AuditEncryptedEnvelope
} from "../src/audit-crypto.js";

test("diagnostic/compact logging hides payloads, arguments and credentials", () => {
  const safe = sanitizeMeta({
    path: "D:\\Work\\Project\\README.md",
    authorization: "Bearer secret",
    token: "secret-token",
    body: "request-body",
    content: "file-content",
    oldText: "before",
    newText: "after",
    args: ["-e", "console.log('secret project text')"],
    stdout: "project output",
    command: "git"
  }, "compact");

  assert.equal(safe.path, "D:\\Work\\Project\\README.md");
  assert.equal(safe.command, "git");
  assert.equal(safe.authorization, "<redacted>");
  assert.equal(safe.token, "<redacted>");
  assert.match(String(safe.body), /^<redacted /);
  assert.match(String(safe.content), /^<redacted /);
  assert.match(String(safe.oldText), /^<redacted /);
  assert.match(String(safe.newText), /^<redacted /);
  assert.match(String(safe.args), /^<redacted /);
  assert.match(String(safe.stdout), /^<redacted /);
});

test("full/trace logging preserves code and output while redacting credentials", () => {
  const safe = sanitizeMeta({
    path: "D:\\Work\\Project\\src\\server.js",
    command: "node",
    args: ["-e", "console.log('full code is visible')"],
    content: "const answer = 42;\nconsole.log(answer);",
    stdout: "full stdout",
    stderr: "",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer super-secret"
    },
    token: "must-not-leak",
    retentionKey: "must-also-not-leak"
  }, "trace");

  assert.deepEqual(safe.args, ["-e", "console.log('full code is visible')"]);
  assert.equal(safe.content, "const answer = 42;\nconsole.log(answer);");
  assert.equal(safe.stdout, "full stdout");
  assert.equal(safe.stderr, "");
  assert.equal((safe.headers as Record<string, unknown>).Accept, "application/json");
  assert.equal((safe.headers as Record<string, unknown>).Authorization, "<redacted>");
  assert.equal(safe.token, "<redacted>");
  assert.equal(safe.retentionKey, "<redacted>");
});

test("full/trace logging hides payloads for sensitive file paths", () => {
  const safe = sanitizeMeta({
    path: "D:\\Work\\Project\\.env",
    content: "APP_SECRET=do-not-show"
  }, "full");

  assert.match(String(safe.content), /^<redacted sensitive-file payload /);
});

test("AuditLogger defaults to off and persists nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-default-off-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({ filePath });

  try {
    assert.equal(logger.mode, "off");
    assert.equal(logger.level, "off");

    const call = await logger.start("command_run", { command: "node", args: ["-e", "console.log('not retained')"] });
    await logger.finish("command_run", call, { stdout: "not retained\n", exitCode: 0 });
    await assert.rejects(readFile(filePath, "utf8"), (error: unknown) => {
      return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit full audit persists compressed encrypted sanitized request and response", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-"));
  const filePath = path.join(dir, "audit.jsonl");
  const recoveryKey = generateAuditRecoveryKey();
  const logger = new AuditLogger({
    mode: "full",
    filePath,
    recoveryKey
  });

  try {
    assert.equal(logger.mode, "full");
    assert.equal(logger.level, "trace");

    const call = await logger.start("command_run", {
      command: "node",
      args: ["-e", "console.log('hello encrypted audit')"],
      authorization: "Bearer do-not-log"
    });
    await logger.finish("command_run", call, {
      stdout: "hello encrypted audit\n",
      stderr: "",
      exitCode: 0
    });

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /hello encrypted audit/);
    assert.doesNotMatch(raw, /do-not-log/);

    const lines = raw.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);

    const startEnvelope = JSON.parse(lines[0] ?? "{}") as AuditEncryptedEnvelope;
    const finishEnvelope = JSON.parse(lines[1] ?? "{}") as AuditEncryptedEnvelope;
    assert.equal(startEnvelope.encrypted, true);
    assert.equal(startEnvelope.alg, "A256GCM");
    assert.equal(startEnvelope.compression, "gzip");
    assert.equal(startEnvelope.kid, auditRecoveryKeyId(recoveryKey));

    const start = decryptAuditRecord(startEnvelope, recoveryKey);
    const finish = decryptAuditRecord(finishEnvelope, recoveryKey);

    assert.equal(start.event, "start");
    assert.equal(start.tool, "command_run");
    assert.deepEqual((start.request as Record<string, unknown>).args, [
      "-e",
      "console.log('hello encrypted audit')"
    ]);
    assert.equal((start.request as Record<string, unknown>).authorization, "<redacted>");

    assert.equal(finish.event, "finish");
    assert.equal(finish.ok, true);
    assert.equal(finish.id, start.id);
    assert.equal((finish.response as Record<string, unknown>).stdout, "hello encrypted audit\n");
    assert.equal((finish.response as Record<string, unknown>).exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full audit without a recovery key fails closed to metadata-only persistence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-nokey-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({
    mode: "full",
    filePath,
    recoveryKey: ""
  });

  try {
    const call = await logger.start("fs_read", {
      path: "D:\\Git\\Project\\private.txt",
      content: "sensitive project body"
    });
    await logger.finish("fs_read", call, {
      content: "sensitive result body"
    });

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /sensitive project body/);
    assert.doesNotMatch(raw, /sensitive result body/);

    const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.auditMode, "full");
      assert.equal(record.payloadRetained, false);
      assert.equal(record.retentionReason, "recovery_key_unavailable");
      assert.equal("request" in record, false);
      assert.equal("response" in record, false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full audit failure text is not persisted plaintext without a recovery key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-error-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({
    mode: "full",
    filePath,
    recoveryKey: ""
  });

  try {
    const call = await logger.start("command_run", { command: "node" });
    await logger.fail("command_run", call, new Error("private failure detail"));

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /private failure detail/);

    const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[1].payloadRetained, false);
    assert.equal("error" in records[1], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostic mode persists metadata but not request/response payload values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-diagnostic-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({
    mode: "diagnostic",
    filePath,
    recoveryKey: ""
  });

  try {
    const call = await logger.start("command_run", {
      command: "node",
      args: ["-e", "console.log('private body')"],
      body: "private body"
    });
    await logger.finish("command_run", call, {
      stdout: "private output",
      exitCode: 0
    });

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /private body/);
    assert.doesNotMatch(raw, /private output/);

    const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records[0].request.command, "node");
    assert.match(String(records[0].request.args), /^<redacted /);
    assert.match(String(records[1].response.stdout), /^<redacted /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("minimal mode persists operation status only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-minimal-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({
    mode: "minimal",
    filePath,
    recoveryKey: ""
  });

  try {
    const call = await logger.start("fs_read", {
      path: "D:\\Git\\Project\\private.txt",
      content: "must not be retained"
    });
    await logger.finish("fs_read", call, {
      content: "must not be retained either"
    });

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 2);
    assert.equal(records[0].tool, "fs_read");
    assert.equal("request" in records[0], false);
    assert.equal("response" in records[1], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("off mode persists nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lcmcp-audit-off-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = new AuditLogger({
    mode: "off",
    filePath,
    recoveryKey: ""
  });

  try {
    const call = await logger.start("fs_read", { content: "not retained" });
    await logger.finish("fs_read", call, { content: "not retained" });
    await assert.rejects(readFile(filePath, "utf8"), (error: unknown) => {
      return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy audit levels map to the new modes", () => {
  assert.equal(new AuditLogger({ level: "off" }).mode, "off");
  assert.equal(new AuditLogger({ level: "compact" }).mode, "diagnostic");
  assert.equal(new AuditLogger({ level: "trace", recoveryKey: "" }).mode, "full");
});

test("audit encryption rejects tampered ciphertext", () => {
  const key = Buffer.alloc(32, 11);
  const envelope = encryptAuditRecord({ event: "test", content: "hello" }, key, "tamper-key");
  const tampered: AuditEncryptedEnvelope = {
    ...envelope,
    tag: Buffer.alloc(16, 0).toString("base64")
  };

  assert.throws(() => decryptAuditRecord(tampered, key));
});


test("generated recovery key is portable while a different key cannot decrypt", () => {
  const recoveryKey = generateAuditRecoveryKey();
  const otherKey = generateAuditRecoveryKey();
  assert.match(recoveryKey, /^lca1_[A-Za-z0-9_-]{43}$/);

  const envelope = encryptAuditRecord(
    { event: "test", content: "only the user's recovery key can open this" },
    recoveryKey
  );
  assert.equal(envelope.kid, auditRecoveryKeyId(recoveryKey));
  assert.equal(
    decryptAuditRecord(envelope, recoveryKey).content,
    "only the user's recovery key can open this"
  );
  assert.throws(() => decryptAuditRecord(envelope, otherKey));
});
