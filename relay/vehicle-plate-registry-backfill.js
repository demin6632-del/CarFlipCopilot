"use strict";

// One-time, resumable backfill. Read-only unless BOTH --apply and
// --confirm-production are supplied. Never run this against production
// without an approved backup and maintenance window.

const { Pool } = require("pg");
const {
  createUniqueVehiclePlate,
  ensureVehiclePlates
} = require("./autonomous-game");
const { syncVehiclePlateRegistry } = require("./vehicle-plate-registry");

const APPLY = process.argv.includes("--apply");
const CONFIRM = process.argv.includes("--confirm-production");
const BATCH_SIZE = 100;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (APPLY && !CONFIRM) {
    throw new Error("Refusing to write: pass both --apply and --confirm-production after approval");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
    statement_timeout: 30000
  });
  pool.on("error", error => {
    console.error("PLATE REGISTRY BACKFILL POOL ERROR:", error?.message || error);
  });

  try {
    if (!APPLY) {
      const audit = await pool.query(`
        WITH profiles AS (
          SELECT
            chat_id,
            state,
            CASE WHEN jsonb_typeof(state->'garage')='array'
              THEN state->'garage' ELSE '[]'::jsonb END AS garage,
            CASE WHEN jsonb_typeof(state->'market')='array'
              THEN state->'market' ELSE '[]'::jsonb END AS market
          FROM autonomous_game_state
        ),
        vehicles AS (
          SELECT chat_id, 'garage'::text AS location, v AS vehicle
          FROM profiles CROSS JOIN LATERAL jsonb_array_elements(garage) v
          UNION ALL
          SELECT chat_id, 'market'::text AS location, v AS vehicle
          FROM profiles CROSS JOIN LATERAL jsonb_array_elements(market) v
        ),
        normalized AS (
          SELECT
            chat_id,
            location,
            NULLIF(BTRIM(vehicle->>'plate'),'') AS plate,
            UPPER(REGEXP_REPLACE(BTRIM(COALESCE(vehicle->>'plate','')), '[[:space:]]+', '', 'g')) AS plate_key
          FROM vehicles
        ),
        duplicate_keys AS (
          SELECT plate_key
          FROM normalized
          WHERE plate_key <> ''
          GROUP BY plate_key
          HAVING COUNT(*) > 1
        )
        SELECT
          (SELECT COUNT(*)::int FROM profiles) AS profiles,
          (SELECT COUNT(*)::int FROM vehicles) AS active_vehicles,
          (SELECT COUNT(*)::int FROM normalized WHERE plate IS NULL) AS vehicles_missing_plates,
          (SELECT COUNT(*)::int FROM normalized WHERE plate_key IN (SELECT plate_key FROM duplicate_keys)) AS vehicles_with_duplicate_plates,
          (SELECT COUNT(DISTINCT plate_key)::int FROM normalized WHERE plate_key <> '') AS distinct_active_plate_keys,
          (SELECT COALESCE(SUM(
            CASE WHEN jsonb_typeof(state->'meta'->'vehiclePlatesIssued')='array'
              THEN jsonb_array_length(state->'meta'->'vehiclePlatesIssued') ELSE 0 END
          ),0)::int FROM profiles) AS historical_plate_entries,
          (SELECT to_regclass('public.vehicle_plate_registry') IS NOT NULL) AS registry_table_exists
      `);
      console.log("DRY RUN — no data was changed.");
      console.log(JSON.stringify(audit.rows[0], null, 2));
      console.log("To apply after an approved backup: node vehicle-plate-registry-backfill.js --apply --confirm-production");
      return;
    }

    const registry = await pool.query(
      "SELECT to_regclass('public.vehicle_plate_registry') IS NOT NULL AS exists"
    );
    if (!registry.rows[0].exists) {
      throw new Error("vehicle_plate_registry is missing; apply and verify the schema first");
    }

    let cursor = null;
    let processed = 0;
    let vehicles = 0;
    let regenerated = 0;
    let retired = 0;

    while (true) {
      const page = await pool.query(
        "SELECT chat_id FROM autonomous_game_state " +
        "WHERE ($1::text IS NULL OR chat_id > $1) ORDER BY chat_id LIMIT $2",
        [cursor, BATCH_SIZE]
      );
      if (!page.rowCount) break;

      for (const item of page.rows) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const locked = await client.query(
            "SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",
            [String(item.chat_id)]
          );
          if (!locked.rowCount) {
            await client.query("COMMIT");
            continue;
          }

          const state = locked.rows[0].state || {};
          state.garage = Array.isArray(state.garage) ? state.garage : [];
          state.market = Array.isArray(state.market) ? state.market : [];
          if (!state.meta || typeof state.meta !== "object") {
            state.meta = { seed: 0, turn: 0, createdAt: Date.now(), day: 1, plateCycle: 0 };
          }

          ensureVehiclePlates(state);
          const result = await syncVehiclePlateRegistry(
            client,
            String(item.chat_id),
            state,
            createUniqueVehiclePlate
          );
          await client.query(
            "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
            [String(item.chat_id), JSON.stringify(state)]
          );
          await client.query("COMMIT");

          processed++;
          vehicles += result.assigned;
          regenerated += result.regenerated;
          retired += result.retired;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }
      cursor = page.rows[page.rows.length - 1].chat_id;
    }

    console.log("Backfill completed. Per-profile transactions committed.");
    console.log(JSON.stringify({ processed_profiles: processed, active_vehicles_registered: vehicles, plates_regenerated: regenerated, vehicles_retired: retired }, null, 2));
    console.log("If interrupted, rerun the same command: reconciliation is designed to be repeatable.");
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error("PLATE REGISTRY BACKFILL FAILED:", error?.message || error);
  process.exitCode = 1;
});
