"use strict";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

function normalizeBatchSize(value) {
  const parsed = value === undefined ? DEFAULT_BATCH_SIZE : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error("BATCH_SIZE_INVALID");
  }
  return parsed;
}

async function deleteExpiredWebSessions(pool, options = {}) {
  if (!pool || typeof pool.query !== "function") throw new Error("DATABASE_POOL_REQUIRED");
  const batchSize = normalizeBatchSize(options.batchSize);
  const result = await pool.query(
    `WITH expired AS (
       SELECT session_hash
         FROM autonomous_web_sessions
        WHERE expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM autonomous_web_sessions AS sessions
      USING expired
      WHERE sessions.session_hash = expired.session_hash
      RETURNING sessions.session_hash`,
    [batchSize]
  );
  return {
    deleted: Number.isInteger(result?.rowCount) ? result.rowCount : 0,
    batchSize
  };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
    statement_timeout: 7000
  });
  pool.on("error", error => {
    console.error("AUTOFLIP SESSION CLEANUP POOL ERROR:", error?.message || error);
  });
  try {
    const result = await deleteExpiredWebSessions(pool, {
      batchSize: process.env.SESSION_CLEANUP_BATCH_SIZE
    });
    console.log("AUTOFLIP expired web sessions cleanup:", JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("AUTOFLIP session cleanup failed:", error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, normalizeBatchSize, deleteExpiredWebSessions };
