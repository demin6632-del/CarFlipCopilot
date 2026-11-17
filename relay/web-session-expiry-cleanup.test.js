"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  normalizeBatchSize,
  deleteExpiredWebSessions
} = require("./web-session-expiry-cleanup");

test("cleanup uses a conservative bounded default batch", () => {
  assert.equal(normalizeBatchSize(undefined), DEFAULT_BATCH_SIZE);
  assert.equal(DEFAULT_BATCH_SIZE, 200);
  assert.equal(MAX_BATCH_SIZE, 1000);
});

test("cleanup rejects invalid and oversized batch sizes", () => {
  for (const value of [0, -1, 1.5, "abc", 1001]) {
    assert.throws(() => normalizeBatchSize(value), /BATCH_SIZE_INVALID/);
  }
});

test("cleanup deletes only expired web sessions in a bounded skip-locked batch", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 7, rows: [] };
    }
  };
  const result = await deleteExpiredWebSessions(pool, { batchSize: 50 });
  assert.deepEqual(result, { deleted: 7, batchSize: 50 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [50]);
  assert.match(calls[0].sql, /FROM autonomous_web_sessions/);
  assert.match(calls[0].sql, /expires_at <= now\(\)/);
  assert.match(calls[0].sql, /LIMIT \$1/);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /DELETE FROM autonomous_web_sessions/);
  assert.doesNotMatch(calls[0].sql, /autonomous_game_state|autonomous_economy_ledger|telegram_account_links/);
});

test("cleanup requires a database pool", async () => {
  await assert.rejects(() => deleteExpiredWebSessions(null), /DATABASE_POOL_REQUIRED/);
});
