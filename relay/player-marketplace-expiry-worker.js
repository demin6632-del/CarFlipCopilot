"use strict";

const { Pool } = require("pg");
const { expireMarketplaceListings } = require("./player-marketplace-listings");

function readBatchSize(value) {
  if (value == null || value === "") return 50;
  if (!/^\\d+$/.test(String(value))) {
    throw new Error("MARKETPLACE_EXPIRY_BATCH_SIZE must be an integer from 1 to 500");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("MARKETPLACE_EXPIRY_BATCH_SIZE must be an integer from 1 to 500");
  }
  return parsed;
}

async function main(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; no database connection was opened");
  }
  const batchSize = readBatchSize(env.MARKETPLACE_EXPIRY_BATCH_SIZE);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    statement_timeout: 15000
  });
  pool.on("error", error => {
    console.error("MARKETPLACE EXPIRY POOL ERROR:", error?.message || error);
  });

  try {
    // This worker intentionally does not apply migrations. The registry and
    // marketplace schemas must already have been reviewed and installed.
    await pool.query("SELECT 1 FROM autonomous_marketplace_listings LIMIT 0");
    const result = await expireMarketplaceListings(pool, { batchSize });
    console.log("MARKETPLACE EXPIRY:", JSON.stringify(result));
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("MARKETPLACE EXPIRY FAILED:", error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { readBatchSize, main };
