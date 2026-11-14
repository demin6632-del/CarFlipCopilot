"use strict";

const crypto = require("node:crypto");

function normalizePlate(plate) {
  return String(plate || "").toUpperCase().replace(/\s+/g, "").trim();
}

// Stable UUID derived from the player scope and the vehicle's existing local ID.
// This is a migration bridge: once vehicleUid is persisted, it always wins.
function stableVehicleUid(ownerChatId, vehicle) {
  if (vehicle && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(vehicle.vehicleUid || ""))) {
    return String(vehicle.vehicleUid);
  }
  const localId = String(vehicle && vehicle.id || "");
  if (!localId) throw new Error("Vehicle is missing its local id");
  const hex = crypto.createHash("sha256")
    .update("AUTOFLIP:vehicle:v1:" + String(ownerChatId) + ":" + localId)
    .digest("hex")
    .slice(0, 32)
    .split("");
  // RFC 4122 UUID variant/version bits (version 5-shaped deterministic UUID).
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join("");
  return raw.slice(0, 8) + "-" + raw.slice(8, 12) + "-" +
    raw.slice(12, 16) + "-" + raw.slice(16, 20) + "-" + raw.slice(20);
}

function activeVehicles(state) {
  return [
    ...(Array.isArray(state && state.garage) ? state.garage : []),
    ...(Array.isArray(state && state.market) ? state.market : [])
  ];
}


/**
 * Reserve or recover globally unique plates for every vehicle in one player's
 * state. MUST be called using the same PostgreSQL client and transaction that
 * writes autonomous_game_state.state.
 *
 * createCandidate(state) must return a fresh formatted plate. The database
 * unique index is the final authority; local checks are only an optimization.
 */
async function syncVehiclePlateRegistry(client, ownerChatId, state, createCandidate) {
  if (!client || typeof client.query !== "function") throw new Error("A transaction client is required");
  if (typeof createCandidate !== "function") throw new Error("A plate candidate generator is required");
  if (!state.meta) state.meta = {};
  if (!Array.isArray(state.meta.vehiclePlatesIssued)) state.meta.vehiclePlatesIssued = [];

  const active = activeVehicles(state);
  const activePlateKeys = new Set(active.map(vehicle => normalizePlate(vehicle.plate)).filter(Boolean));
  const historicalValues = new Set(state.meta.vehiclePlatesIssued.map(value => String(value || "").trim()).filter(value => value && !activePlateKeys.has(normalizePlate(value))));
  const localSeen = new Set();
  let assigned = 0;
  let regenerated = 0;

  // Import historical values in one query instead of one round-trip per
  // plate. Do not let a legacy history entry overwrite an active registry row.
  if (historicalValues.size) {
    await client.query(
      "INSERT INTO vehicle_plate_registry(plate, source, retired_at) " +
      "SELECT value, 'legacy-history', now() FROM unnest($1::text[]) AS value " +
      "ON CONFLICT DO NOTHING",
      [[...historicalValues]]
    );
  }

  for (const vehicle of active) {
    const uid = stableVehicleUid(ownerChatId, vehicle);
    vehicle.vehicleUid = uid;
    let plate = String(vehicle.plate || "").trim();
    let accepted = false;

    // Keep a legacy plate only if it is not duplicated locally and the global
    // registry says it belongs to this exact vehicle.
    if (plate && !localSeen.has(normalizePlate(plate))) {
      const claim = await client.query(
        "INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source) " +
        "VALUES($1, $2::uuid, $3, 'state-reconcile') " +
        "ON CONFLICT DO NOTHING RETURNING plate",
        [plate, uid, String(ownerChatId)]
      );
      if (claim.rowCount) {
        accepted = true;
      } else {
        const existing = await client.query(
          "SELECT plate, vehicle_uid, owner_chat_id, retired_at FROM vehicle_plate_registry " +
          "WHERE vehicle_uid=$1::uuid LIMIT 1",
          [uid]
        );
        const row = existing.rows[0];
        if (row && !row.retired_at) {
          if (String(row.owner_chat_id) !== String(ownerChatId)) {
            throw new Error("Vehicle ownership conflict: explicit transfer is required");
          }
          plate = row.plate;
          accepted = true;
        }
      }
    }

    if (!accepted) {
      // A duplicate, retired, or foreign-owned legacy plate must not be reused.
      // A bounded retry avoids an infinite loop if the candidate source is bad.
      for (let attempt = 0; attempt < 40 && !accepted; attempt++) {
        const candidate = String(createCandidate(state) || "").trim();
        if (!candidate || localSeen.has(normalizePlate(candidate))) continue;
        const result = await client.query(
          "INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source) " +
          "VALUES($1, $2::uuid, $3, 'state-reconcile') " +
          "ON CONFLICT DO NOTHING RETURNING plate",
          [candidate, uid, String(ownerChatId)]
        );
        if (result.rowCount) {
          plate = candidate;
          accepted = true;
          regenerated++;
        }
      }
    }

    if (!accepted) {
      throw new Error("Unable to reserve a globally unique plate after 40 attempts");
    }
    vehicle.plate = plate;
    localSeen.add(normalizePlate(plate));
    historicalValues.add(plate);
    assigned++;
  }

  // Vehicles removed from this player's active garage/market are retired.
  // A transfer must update owner_chat_id first in the same transaction; after
  // that, the old owner's reconciliation cannot retire the transferred row.
  const activeUids = active.map(vehicle => String(vehicle.vehicleUid));
  const retiredResult = await client.query(
    "UPDATE vehicle_plate_registry SET retired_at=now() " +
    "WHERE owner_chat_id=$1 AND retired_at IS NULL AND vehicle_uid IS NOT NULL " +
    "AND NOT (vehicle_uid = ANY($2::uuid[])) RETURNING plate",
    [String(ownerChatId), activeUids]
  );

  state.meta.vehiclePlatesIssued = [...historicalValues];
  return { assigned, regenerated, retired: retiredResult.rowCount || 0 };
}

async function transferVehicleOwner(client, vehicleUid, fromOwnerChatId, toOwnerChatId) {
  if (!client || typeof client.query !== "function") throw new Error("A transaction client is required");
  const result = await client.query(
    "UPDATE vehicle_plate_registry SET owner_chat_id=$3 " +
    "WHERE vehicle_uid=$1::uuid AND owner_chat_id=$2 AND retired_at IS NULL " +
    "RETURNING plate",
    [String(vehicleUid), String(fromOwnerChatId), String(toOwnerChatId)]
  );
  if (!result.rowCount) throw new Error("Vehicle transfer rejected: source owner does not match");
  return result.rows[0];
}

module.exports = {
  normalizePlate,
  stableVehicleUid,
  activeVehicles,
  syncVehiclePlateRegistry,
  transferVehicleOwner
};
