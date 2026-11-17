"use strict";

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;

/**
 * Delete at most one bounded batch of expired sessions.
 * SKIP LOCKED allows multiple maintenance workers without blocking each other.
 * This function never reads or returns session tokens or account identifiers.
 */
async function cleanupExpiredWebSessions(pool, options = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("DATABASE_POOL_REQUIRED");
  }
  const batchSize = options.batchSize === undefined
    ? DEFAULT_BATCH_SIZE
    : options.batchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error("BATCH_SIZE_INVALID");
  }

  const result = await pool.query(
    `WITH expired_sessions AS (
       SELECT session_hash
         FROM autonomous_web_sessions
        WHERE expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM autonomous_web_sessions AS sessions
      USING expired_sessions
      WHERE sessions.session_hash = expired_sessions.session_hash`,
    [batchSize]
  );
  return Number(result?.rowCount || 0);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
    statement_timeout: 7000
  });
  pool.on("error", error => {
    console.error("AUTOFLIP WEB SESSION CLEANUP POOL ERROR:", error?.message || error);
  });

  try {
    const configured = process.env.WEB_SESSION_CLEANUP_BATCH_SIZE === undefined
      ? DEFAULT_BATCH_SIZE
      : Number(process.env.WEB_SESSION_CLEANUP_BATCH_SIZE);
    const deleted = await cleanupExpiredWebSessions(pool, { batchSize: configured });
    console.log("AUTOFLIP expired web sessions cleaned:", deleted);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("AUTOFLIP web session cleanup failed:", error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  cleanupExpiredWebSessions
};
