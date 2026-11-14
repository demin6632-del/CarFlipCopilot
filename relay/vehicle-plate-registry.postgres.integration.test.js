"use strict";

const assert = require("node:assert/strict");
const { Pool } = require("pg");
const {
  normalizePlate,
  syncVehiclePlateRegistry,
  transferVehicleOwner
} = require("./vehicle-plate-registry");

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
