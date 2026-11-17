"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  cleanupExpiredWebSessions
} = require("./web-account-session-cleanup");

test("cleanup deletes only a bounded batch of expired sessions", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 17 };
    }
  };

  const deleted = await cleanupExpiredWebSessions(pool);
  assert.equal(deleted, 17);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [DEFAULT_BATCH_SIZE]);
  assert.match(calls[0].sql, /expires_at <= now\(\)/);
  assert.match(calls[0].sql, /ORDER BY expires_at ASC/);
  assert.match(calls[0].sql, /LIMIT \$1/);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /DELETE FROM autonomous_web_sessions/);
});

test("cleanup accepts an explicit safe batch size", async () => {
  let received;
  const deleted = await cleanupExpiredWebSessions({
    async query(_sql, params) {
      received = params[0];
      return { rowCount: 3 };
    }
  }, { batchSize: 40 });
  assert.equal(received, 40);
  assert.equal(deleted, 3);
});

test("cleanup rejects unbounded or invalid batch sizes", async () => {
  const pool = { async query() { throw new Error("QUERY_MUST_NOT_RUN"); } };
  for (const batchSize of [0, -1, 1.5, MAX_BATCH_SIZE + 1, "20", null]) {
    await assert.rejects(
      cleanupExpiredWebSessions(pool, { batchSize }),
      { message: "BATCH_SIZE_INVALID" }
    );
  }
});

test("cleanup requires a query-capable database pool", async () => {
  await assert.rejects(
    cleanupExpiredWebSessions(null),
    { message: "DATABASE_POOL_REQUIRED" }
  );
});
