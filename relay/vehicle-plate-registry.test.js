"use strict";

const assert = require("node:assert/strict");
const registry = require("./vehicle-plate-registry");

class FakeTransactionClient {
  constructor() { this.byPlate = new Map(); this.byUid = new Map(); }
  async query(sql, params = []) {
    if (sql.includes("INSERT INTO vehicle_plate_registry")) {
      const plate = String(params[0]);
      const key = registry.normalizePlate(plate);
      if (sql.includes("'legacy-history'")) {
        const plates = Array.isArray(params[0]) ? params[0] : [params[0]];
        let inserted = 0;
        for (const value of plates) {
          const historicalPlate = String(value);
          const historicalKey = registry.normalizePlate(historicalPlate);
          if (!this.byPlate.has(historicalKey)) {
            this.byPlate.set(historicalKey, { plate: historicalPlate, vehicle_uid: null, retired_at: true });
            inserted++;
          }
        }
        return { rowCount: inserted, rows: [] };
      }
      const uid = String(params[1]);
      if (this.byPlate.has(key) || this.byUid.has(uid)) return { rowCount: 0, rows: [] };
      const row = { plate, vehicle_uid: uid, owner_chat_id: String(params[2]), retired_at: null };
      this.byPlate.set(key, row);
      this.byUid.set(uid, row);
      return { rowCount: 1, rows: [{ plate }] };
    }
    if (sql.includes("SELECT plate, owner_chat_id, retired_at") || sql.includes("SELECT plate, vehicle_uid, owner_chat_id, retired_at")) {
      const row = this.byUid.get(String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.includes("NOT (vehicle_uid = ANY")) {
      const owner = String(params[0]);
      const active = new Set(params[1].map(String));
      const retired = [];
      for (const row of this.byUid.values()) {
        if (row.owner_chat_id === owner && !row.retired_at && !active.has(String(row.vehicle_uid))) {
          row.retired_at = true;
          retired.push({ plate: row.plate });
        }
      }
      return { rowCount: retired.length, rows: retired };
    }
    if (sql.includes("UPDATE vehicle_plate_registry") && sql.includes("RETURNING plate")) {
      const row = this.byUid.get(String(params[0]));
      if (!row || row.owner_chat_id !== String(params[1]) || row.retired_at) return { rowCount: 0, rows: [] };
      row.owner_chat_id = String(params[2]);
      return { rowCount: 1, rows: [{ plate: row.plate }] };
    }
    if (sql.includes("UPDATE vehicle_plate_registry")) {
      const row = this.byUid.get(String(params[0]));
      if (row) row.owner_chat_id = String(params[1]);
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    throw new Error("Unexpected SQL in fake client: " + sql);
  }
}

async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
}

(async () => {
  await test("plate normalization ignores case and whitespace", () => {
    assert.equal(registry.normalizePlate("а123 вс 77"), "А123ВС77");
  });

  await test("vehicle UUID is stable for legacy local IDs", () => {
    const a = registry.stableVehicleUid("player-1", { id: "car_1_1" });
    const b = registry.stableVehicleUid("player-1", { id: "car_1_1" });
    const c = registry.stableVehicleUid("player-2", { id: "car_1_1" });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  await test("active legacy plates are not incorrectly imported as retired history", async () => {
    const client = new FakeTransactionClient();
    const state = {
      meta: { vehiclePlatesIssued: ["А123ВС 77"] },
      garage: [{ id: "owned-1", plate: "А123ВС 77" }],
      market: []
    };
    const result = await registry.syncVehiclePlateRegistry(client, "player-1", state, () => "В456ОР 77");
    assert.equal(result.assigned, 1);
    assert.equal(result.regenerated, 0);
    assert.equal(state.garage[0].plate, "А123ВС 77");
    assert.equal(client.byPlate.get("А123ВС77").retired_at, null);
    assert.ok(state.garage[0].vehicleUid);
  });

  await test("second reconciliation preserves the same vehicle plate and UID", async () => {
    const client = new FakeTransactionClient();
    const state = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "car-1", plate: "А123ВС 77" }], market: [] };
    await registry.syncVehiclePlateRegistry(client, "player-1", state, () => "В456ОР 77");
    const uid = state.garage[0].vehicleUid;
    const again = await registry.syncVehiclePlateRegistry(client, "player-1", state, () => "Г789СТ 77");
    assert.equal(state.garage[0].vehicleUid, uid);
    assert.equal(state.garage[0].plate, "А123ВС 77");
    assert.equal(again.regenerated, 0);
  });

  await test("globally occupied legacy plate is replaced by a newly reserved candidate", async () => {
    const client = new FakeTransactionClient();
    client.byPlate.set("А123ВС77", { plate: "А123ВС 77", vehicle_uid: "00000000-0000-5000-8000-000000000001", retired_at: null });
    client.byUid.set("00000000-0000-5000-8000-000000000001", client.byPlate.get("А123ВС77"));
    const state = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "car-2", plate: "А123ВС 77" }], market: [] };
    const result = await registry.syncVehiclePlateRegistry(client, "player-2", state, () => "В456ОР 77");
    assert.equal(state.garage[0].plate, "В456ОР 77");
    assert.equal(result.regenerated, 1);
    assert.equal(client.byPlate.get("А123ВС77").vehicle_uid, "00000000-0000-5000-8000-000000000001");
  });

  await test("ownership transfer requires the current owner and preserves plate", async () => {
    const client = new FakeTransactionClient();
    const state = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "transfer-car", plate: "А123ВС 77" }], market: [] };
    await registry.syncVehiclePlateRegistry(client, "old-owner", state, () => "В456ОР 77");
    const uid = state.garage[0].vehicleUid;
    const transfer = await registry.transferVehicleOwner(client, uid, "old-owner", "new-owner");
    assert.equal(transfer.plate, "А123ВС 77");
    assert.equal(client.byUid.get(uid).owner_chat_id, "new-owner");
    const oldOwnerState = { meta: { vehiclePlatesIssued: ["А123ВС 77"] }, garage: [], market: [] };
    const oldSync = await registry.syncVehiclePlateRegistry(client, "old-owner", oldOwnerState, () => "В456ОР 77");
    assert.equal(oldSync.retired, 0, "old owner reconciliation must not retire a transferred vehicle");
    const newOwnerState = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "transfer-car", vehicleUid: uid, plate: "А123ВС 77" }], market: [] };
    const newSync = await registry.syncVehiclePlateRegistry(client, "new-owner", newOwnerState, () => "Г789СТ 77");
    assert.equal(newSync.regenerated, 0);
    assert.equal(newOwnerState.garage[0].plate, "А123ВС 77");
    await assert.rejects(() => registry.transferVehicleOwner(client, uid, "old-owner", "third-owner"));
  });

  await test("reconciliation cannot silently steal a vehicle from another owner", async () => {
    const client = new FakeTransactionClient();
    client.byPlate.set("А123ВС77", { plate: "А123ВС 77", vehicle_uid: "00000000-0000-5000-8000-000000000001", owner_chat_id: "owner-a", retired_at: null });
    client.byUid.set("00000000-0000-5000-8000-000000000001", client.byPlate.get("А123ВС77"));
    const state = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "copied-car", vehicleUid: "00000000-0000-5000-8000-000000000001", plate: "А123ВС 77" }], market: [] };
    await assert.rejects(() => registry.syncVehiclePlateRegistry(client, "owner-b", state, () => "В456ОР 77"), /ownership conflict/);
  });

  await test("duplicate plates inside one player state are separated", async () => {
    const client = new FakeTransactionClient();
    const state = {
      meta: { vehiclePlatesIssued: ["А123ВС 77"] },
      garage: [{ id: "car-a", plate: "А123ВС 77" }],
      market: [{ id: "car-b", plate: "а123 вс 77" }]
    };
    let next = 0;
    const result = await registry.syncVehiclePlateRegistry(client, "player-4", state, () => (++next === 1 ? "А123ВС 77" : "В456ОР 77"));
    assert.equal(result.assigned, 2);
    assert.equal(result.regenerated, 1);
    assert.equal(registry.normalizePlate(state.garage[0].plate) === registry.normalizePlate(state.market[0].plate), false);
  });

  await test("vehicle removed from active state is retired and its plate stays reserved", async () => {
    const client = new FakeTransactionClient();
    const state = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "sold-car", plate: "А123ВС 77" }], market: [] };
    await registry.syncVehiclePlateRegistry(client, "seller", state, () => "В456ОР 77");
    const uid = state.garage[0].vehicleUid;
    state.garage = [];
    const result = await registry.syncVehiclePlateRegistry(client, "seller", state, () => "Г789СТ 77");
    assert.equal(result.retired, 1);
    assert.ok(client.byUid.get(uid).retired_at);
    const buyer = { meta: { vehiclePlatesIssued: [] }, garage: [{ id: "new-car", plate: "А123ВС 77" }], market: [] };
    await registry.syncVehiclePlateRegistry(client, "buyer", buyer, () => "Г789СТ 77");
    assert.equal(buyer.garage[0].plate, "Г789СТ 77");
  });

  await test("retired historical plates are never reissued", async () => {
    const client = new FakeTransactionClient();
    client.byPlate.set("А123ВС77", { plate: "А123ВС 77", vehicle_uid: null, retired_at: true });
    const state = {
      meta: { vehiclePlatesIssued: ["А123ВС 77"] },
      garage: [{ id: "car-3", plate: "А123ВС 77" }],
      market: []
    };
    const result = await registry.syncVehiclePlateRegistry(client, "player-3", state, () => "В456ОР 77");
    assert.equal(result.regenerated, 1);
    assert.equal(state.garage[0].plate, "В456ОР 77");
    assert.ok(client.byPlate.get("А123ВС77").retired_at);
  });

  console.log("Vehicle plate registry tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
