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
