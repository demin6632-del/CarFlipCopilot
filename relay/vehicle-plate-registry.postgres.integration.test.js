"use strict";

const assert = require("node:assert/strict");
const pg = require("pg");
const { Pool } = pg;
const {
  normalizePlate,
  syncVehiclePlateRegistry,
  transferVehicleOwner
} = require("./vehicle-plate-registry");

async function testTransactionalLoad(pool) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const OriginalPool = pg.Pool;
  let gamePool = null;
  pg.Pool = class TestPool extends OriginalPool {
    constructor(config) {
      super({ ...config, ssl: false });
      gamePool = this;
    }
  };

  try {
    const game = require("./autonomous-game");
    assert.equal(await game.init(), true, "game database initializes on the disposable PostgreSQL instance");

    const legacyState = game.newState("load-integration-player", "Legacy");
    legacyState.garage = [{ id: "legacy-garage-car", plate: "" }];
    legacyState.market = [{ id: "legacy-market-car", plate: "" }];
    legacyState.meta.vehiclePlatesIssued = [];
    await pool.query(
      "INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,$2,$3::jsonb)",
      ["load-integration-player", 2, JSON.stringify(legacyState)]
    );

    const loaded = await game.load("load-integration-player", "Legacy");
    const active = [...loaded.garage, ...loaded.market];
    assert.equal(active.length, 2);
    for (const vehicle of active) {
      assert.ok(vehicle.plate, "load() assigns a plate before returning the profile");
      assert.ok(vehicle.vehicleUid, "load() persists a stable vehicle UID before returning the profile");
    }

    const stored = await pool.query(
      "SELECT state FROM autonomous_game_state WHERE chat_id=$1",
      ["load-integration-player"]
    );
    assert.equal(stored.rowCount, 1);
    assert.deepEqual(stored.rows[0].state.garage, loaded.garage);
    assert.deepEqual(stored.rows[0].state.market, loaded.market);

    const registryRows = await pool.query(
      "SELECT vehicle_uid FROM vehicle_plate_registry WHERE owner_chat_id=$1 AND retired_at IS NULL",
      ["load-integration-player"]
    );
    assert.equal(registryRows.rowCount, 2, "both legacy vehicles are registered before load() returns");
    const registered = new Set(registryRows.rows.map(row => String(row.vehicle_uid)));
    assert.ok(active.every(vehicle => registered.has(vehicle.vehicleUid)));
    console.log("PostgreSQL transactional load integration: OK");

    // Two first-time requests for the same player must converge on one
    // profile and one stable set of registered vehicles.
    const [concurrentLoadA, concurrentLoadB] = await Promise.all([
      game.load("concurrent-new-player", "Concurrent"),
      game.load("concurrent-new-player", "Concurrent")
    ]);
    assert.deepEqual(
      concurrentLoadA.garage.map(vehicle => [vehicle.vehicleUid, vehicle.plate]),
      concurrentLoadB.garage.map(vehicle => [vehicle.vehicleUid, vehicle.plate]),
      "concurrent first loads return the same stable garage"
    );
    assert.deepEqual(
      concurrentLoadA.market.map(vehicle => [vehicle.vehicleUid, vehicle.plate]),
      concurrentLoadB.market.map(vehicle => [vehicle.vehicleUid, vehicle.plate]),
      "concurrent first loads return the same stable market"
    );
    const concurrentProfile = await pool.query(
      "SELECT COUNT(*)::int AS profiles FROM autonomous_game_state WHERE chat_id=$1",
      ["concurrent-new-player"]
    );
    assert.equal(concurrentProfile.rows[0].profiles, 1, "only one profile is created");
    const concurrentRegistry = await pool.query(
      "SELECT COUNT(*)::int AS active_vehicles, COUNT(DISTINCT plate_key)::int AS unique_plates " +
      "FROM vehicle_plate_registry WHERE owner_chat_id=$1 AND retired_at IS NULL",
      ["concurrent-new-player"]
    );
    assert.equal(
      concurrentRegistry.rows[0].active_vehicles,
      concurrentRegistry.rows[0].unique_plates,
      "concurrent profile creation cannot duplicate plate reservations"
    );
    console.log("PostgreSQL concurrent first-load integration: OK");
  } finally {
    pg.Pool = OriginalPool;
    if (gamePool) await gamePool.end();
  }
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ownerA = {
      meta: { vehiclePlatesIssued: [] },
      garage: [{ id: "car-a", plate: "AA0001" }],
      market: []
    };
    await syncVehiclePlateRegistry(client, "integration-owner-a", ownerA, () => "AA0002");
    const uidA = ownerA.garage[0].vehicleUid;
    assert.ok(uidA, "first vehicle receives a stable UID");
    assert.equal(normalizePlate(ownerA.garage[0].plate), "AA0001");

    const repeated = await syncVehiclePlateRegistry(client, "integration-owner-a", ownerA, () => "AA0003");
    assert.equal(repeated.regenerated, 0, "repeat reconciliation preserves the existing plate");
    assert.equal(ownerA.garage[0].vehicleUid, uidA);

    const ownerB = {
      meta: { vehiclePlatesIssued: [] },
      garage: [{ id: "car-b", plate: "AA0001" }],
      market: []
    };
    const collision = await syncVehiclePlateRegistry(client, "integration-owner-b", ownerB, () => "BB0001");
    assert.equal(collision.regenerated, 1, "a second player cannot claim the first player's plate");
    assert.equal(normalizePlate(ownerB.garage[0].plate), "BB0001");
    const uidB = ownerB.garage[0].vehicleUid;

    await transferVehicleOwner(client, uidA, "integration-owner-a", "integration-owner-b");
    const oldOwnerState = {
      meta: { vehiclePlatesIssued: ["AA0001"] },
      garage: [],
      market: []
    };
    const oldOwnerSync = await syncVehiclePlateRegistry(client, "integration-owner-a", oldOwnerState, () => "OLD0001");
    assert.equal(oldOwnerSync.retired, 0, "old-owner reconciliation does not retire a transferred vehicle");

    const newOwnerState = {
      meta: { vehiclePlatesIssued: [] },
      garage: [
        { id: "car-a", vehicleUid: uidA, plate: "AA0001" },
        { id: "car-b", vehicleUid: uidB, plate: "BB0001" }
      ],
      market: []
    };
    await syncVehiclePlateRegistry(client, "integration-owner-b", newOwnerState, () => "NEW0001");
    assert.equal(normalizePlate(newOwnerState.garage[0].plate), "AA0001", "transfer keeps the original plate");

    newOwnerState.garage = newOwnerState.garage.filter(vehicle => vehicle.vehicleUid !== uidA);
    const retired = await syncVehiclePlateRegistry(client, "integration-owner-b", newOwnerState, () => "NEW0002");
    assert.equal(retired.retired, 1, "a vehicle leaving circulation is retired");
    const retiredRow = await client.query(
      "SELECT retired_at FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid",
      [uidA]
    );
    assert.ok(retiredRow.rows[0] && retiredRow.rows[0].retired_at, "retired timestamp is persisted");

    const ownerC = {
      meta: { vehiclePlatesIssued: [] },
      garage: [{ id: "car-c", plate: "AA0001" }],
      market: []
    };
    await syncVehiclePlateRegistry(client, "integration-owner-c", ownerC, () => "CC0001");
    assert.equal(normalizePlate(ownerC.garage[0].plate), "CC0001", "a retired plate is never reissued");

    const historyOwner = {
      meta: { vehiclePlatesIssued: ["HIST0001"] },
      garage: [{ id: "history-car", plate: "LIVE0001" }],
      market: []
    };
    await syncVehiclePlateRegistry(client, "integration-history-owner", historyOwner, () => "LIVE0002");
    const historyRow = await client.query(
      "SELECT retired_at FROM vehicle_plate_registry WHERE plate_key=$1",
      ["HIST0001"]
    );
    assert.ok(historyRow.rows[0] && historyRow.rows[0].retired_at, "legacy history is imported as permanently retired");

    console.log("PostgreSQL application-helper integration: OK");
    await client.query("ROLLBACK");

    const rollbackCheck = await pool.query(
      "SELECT COUNT(*)::int AS remaining FROM vehicle_plate_registry " +
      "WHERE owner_chat_id LIKE 'integration-%' OR plate_key='HIST0001'"
    );
    assert.equal(rollbackCheck.rows[0].remaining, 0, "test transaction leaves no registry rows behind");

    await pool.query("CREATE SCHEMA registry_concurrency_test");
    try {
      await pool.query(`
        CREATE TABLE registry_concurrency_test.vehicle_plate_registry (
          plate text PRIMARY KEY,
          plate_key text GENERATED ALWAYS AS (
            upper(regexp_replace(btrim(plate), '[[:space:]]+', '', 'g'))
          ) STORED,
          vehicle_uid uuid UNIQUE,
          owner_chat_id text,
          issued_at timestamptz NOT NULL DEFAULT now(),
          retired_at timestamptz,
          source text NOT NULL DEFAULT 'application',
          CHECK (length(btrim(plate)) > 0),
          CHECK (retired_at IS NULL OR retired_at >= issued_at)
        );
        CREATE UNIQUE INDEX registry_concurrency_test_plate_key_uidx
          ON registry_concurrency_test.vehicle_plate_registry(plate_key);
      `);

      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        await firstClient.query("SET search_path TO registry_concurrency_test, public");
        await secondClient.query("SET search_path TO registry_concurrency_test, public");
        await firstClient.query("BEGIN");
        await secondClient.query("BEGIN");

        const firstState = {
          meta: { vehiclePlatesIssued: [] },
          garage: [{ id: "race-car-a", plate: "RACE0001" }],
          market: []
        };
        await syncVehiclePlateRegistry(firstClient, "race-owner-a", firstState, () => "RACE0002");

        const secondState = {
          meta: { vehiclePlatesIssued: [] },
          garage: [{ id: "race-car-b", plate: "RACE0001" }],
          market: []
        };
        const fallbackPlates = ["RACE0001", "RACE0002"];
        const secondReservation = syncVehiclePlateRegistry(
          secondClient,
          "race-owner-b",
          secondState,
          () => fallbackPlates.shift()
        );

        // The second INSERT is waiting on the same normalized unique key.
        // Committing the first owner forces the second transaction to retry.
        await firstClient.query("COMMIT");
        await secondReservation;
        await secondClient.query("COMMIT");

        assert.equal(normalizePlate(firstState.garage[0].plate), "RACE0001");
        assert.equal(normalizePlate(secondState.garage[0].plate), "RACE0002");
        const concurrentRows = await firstClient.query(
          "SELECT COUNT(*)::int AS total, COUNT(DISTINCT plate_key)::int AS unique_total " +
          "FROM vehicle_plate_registry"
        );
        assert.equal(concurrentRows.rows[0].total, 2);
        assert.equal(concurrentRows.rows[0].unique_total, 2);
        console.log("PostgreSQL concurrent reservation integration: OK");
      } catch (error) {
        await firstClient.query("ROLLBACK").catch(() => {});
        await secondClient.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        firstClient.release();
        secondClient.release();
      }
    } finally {
      await pool.query("DROP SCHEMA IF EXISTS registry_concurrency_test CASCADE");
    }

    await testTransactionalLoad(pool);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
