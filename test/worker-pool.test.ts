import assert from "node:assert/strict";
import test from "node:test";
import { ElasticWorkerPool } from "../src/worker-pool.js";

test("worker pool keeps two warm workers and grows by two when exhausted", () => {
  let now = 1_000;
  const pool = new ElasticWorkerPool({ warmWorkers: 2, growBy: 2, maxWorkers: 8, idleTtlMs: 100, now: () => now });

  assert.deepEqual(
    { total: pool.snapshot().total, idle: pool.snapshot().idle, busy: pool.snapshot().busy },
    { total: 2, idle: 2, busy: 0 }
  );

  const first = pool.lease({ requestId: 1, tool: "fs_read" });
  const second = pool.lease({ requestId: 2, tool: "fs_write" });
  assert.deepEqual(
    { total: pool.snapshot().total, idle: pool.snapshot().idle, busy: pool.snapshot().busy },
    { total: 4, idle: 2, busy: 2 }
  );

  const third = pool.lease({ requestId: 3, tool: "command_run" });
  assert.deepEqual(
    { total: pool.snapshot().total, idle: pool.snapshot().idle, busy: pool.snapshot().busy },
    { total: 4, idle: 1, busy: 3 }
  );
  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);

  first.release();
  second.release();
  third.release();
  assert.deepEqual(
    { total: pool.snapshot().total, idle: pool.snapshot().idle, busy: pool.snapshot().busy },
    { total: 4, idle: 4, busy: 0 }
  );

  now += 101;
  assert.deepEqual(
    { total: pool.snapshot().total, idle: pool.snapshot().idle, busy: pool.snapshot().busy },
    { total: 2, idle: 2, busy: 0 }
  );
});

test("worker pool is bounded and released workers are reusable", () => {
  const pool = new ElasticWorkerPool({ warmWorkers: 2, growBy: 2, maxWorkers: 4, idleTtlMs: 1000 });
  const leases = [
    pool.lease({ requestId: 1, tool: "a" }),
    pool.lease({ requestId: 2, tool: "b" }),
    pool.lease({ requestId: 3, tool: "c" }),
    pool.lease({ requestId: 4, tool: "d" })
  ];
  assert.throws(() => pool.lease({ requestId: 5, tool: "e" }), /WORKER_POOL_EXHAUSTED/);

  const releasedId = leases[1]!.id;
  leases[1]!.release();
  const reused = pool.lease({ requestId: 6, tool: "f" });
  assert.equal(reused.id, releasedId);

  reused.release();
  for (const [index, lease] of leases.entries()) if (index !== 1) lease.release();
  assert.equal(pool.snapshot().busy, 0);
});
