import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnvironment } from "../src/child-environment.js";

test("buildChildEnvironment copies only conservative allowlisted keys", () => {
  const env = buildChildEnvironment(
    {
      PATH: "/bin",
      HOME: "/home/user",
      LANG: "C.UTF-8",
      LCMCP_TOKEN: "secret",
      PAYPAL_SECRET: "secret",
      SQL_CONNECTION_STRING: "secret",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require ./evil.js",
      PYTHONPATH: "./evil",
      RANDOM_PROJECT_SECRET: "secret"
    },
    "linux"
  );

  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.LCMCP_TOKEN, undefined);
  assert.equal(env.PAYPAL_SECRET, undefined);
  assert.equal(env.SQL_CONNECTION_STRING, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.RANDOM_PROJECT_SECRET, undefined);
});

test("buildChildEnvironment deduplicates Windows keys case-insensitively", () => {
  const env = buildChildEnvironment(
    {
      Path: "C:\\Windows\\System32",
      PATH: "C:\\Other",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\Test",
      NODE_OPTIONS: "--require evil"
    },
    "win32"
  );

  assert.equal(env.PATH, "C:\\Windows\\System32");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(env.COMSPEC, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(env.USERPROFILE, "C:\\Users\\Test");
  assert.equal(env.NODE_OPTIONS, undefined);
});
