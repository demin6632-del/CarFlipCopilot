"use strict";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRICE = 1000000000000;
const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 24 * 30;

function marketplaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateListingInput({ sellerChatId, vehicleId, askingPrice, expiresInHours = 168 }) {
  if (sellerChatId == null || !String(sellerChatId).trim()) {
    throw marketplaceError("INVALID_SELLER", "Seller account is required");
  }
  if (vehicleId == null || !String(vehicleId).trim()) {
    throw marketplaceError("INVALID_VEHICLE", "Vehicle ID is required");
  }
  if (!Number.isSafeInteger(askingPrice) || askingPrice <= 0 || askingPrice > MAX_PRICE) {
    throw marketplaceError("INVALID_PRICE", "Asking price must be a positive whole-ruble amount");
  }
  if (!Number.isInteger(expiresInHours) || expiresInHours < MIN_EXPIRY_HOURS || expiresInHours > MAX_EXPIRY_HOURS) {
    throw marketplaceError("INVALID_EXPIRY", "Listing expiry must be between 1 hour and 30 days");
  }
}

function vehicleSnapshot(car) {
  return {
    model: String(car.model || "Неизвестная модель").slice(0, 120),
    catalogId: String(car.catalogId || "").slice(0, 80),
    year: Number.isInteger(Number(car.year)) ? Number(car.year) : null,
    plate: String(car.plate || "").slice(0, 24),
    mileage: Math.max(0, Math.floor(Number(car.mileage) || 0)),
    condition: Math.max(0, Math.min(100, Math.floor(Number(car.condition) || 0))),
    damage: Math.max(0, Math.floor(Number(car.damage) || 0))
  };
}

async function createMarketplaceListing(pool, input) {
  validateListingInput(input);
  const sellerChatId = String(input.sellerChatId);
  const vehicleId = String(input.vehicleId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stateResult = await client.query(
      "SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",
      [sellerChatId]
    );
    if (!stateResult.rowCount) throw marketplaceError("PROFILE_NOT_FOUND", "Player profile was not found");
    const state = stateResult.rows[0].state;
    state.garage = Array.isArray(state.garage) ? state.garage : [];
    const car = state.garage.find(item => String(item.id) === vehicleId);
    if (!car) throw marketplaceError("VEHICLE_NOT_OWNED", "Vehicle is not in the seller's garage");
    if (!UUID_RE.test(String(car.vehicleUid || ""))) {
      throw marketplaceError("REGISTRY_NOT_READY", "Vehicle has no stable global registry ID yet");
    }
    if (!String(car.plate || "").trim()) {
      throw marketplaceError("REGISTRY_NOT_READY", "Vehicle has no registered plate");
    }
    if (car.marketplaceListingId) {
      throw marketplaceError("ALREADY_LISTED", "Vehicle already has an active marketplace listing");
    }

    const registry = await client.query(
      "SELECT plate, owner_chat_id, retired_at FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid FOR UPDATE",
      [String(car.vehicleUid)]
    );
    if (!registry.rowCount || registry.rows[0].retired_at ||
        String(registry.rows[0].owner_chat_id) !== sellerChatId ||
        String(registry.rows[0].plate) !== String(car.plate)) {
      throw marketplaceError("REGISTRY_OWNERSHIP_MISMATCH", "Global vehicle registry does not confirm this seller's ownership");
    }

    const duplicate = await client.query(
      "SELECT id FROM autonomous_marketplace_listings WHERE vehicle_uid=$1::uuid AND status='active' FOR UPDATE",
      [String(car.vehicleUid)]
    );
    if (duplicate.rowCount) throw marketplaceError("ALREADY_LISTED", "Vehicle already has an active marketplace listing");

    const inserted = await client.query(
      "INSERT INTO autonomous_marketplace_listings(vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
      "VALUES($1::uuid,$2,$3,'active',$4::jsonb,now()+($5::text || ' hours')::interval) RETURNING id,created_at,expires_at",
      [String(car.vehicleUid), sellerChatId, input.askingPrice, JSON.stringify(vehicleSnapshot(car)), input.expiresInHours ?? 168]
    );
    const listing = inserted.rows[0];
    car.marketplaceListingId = String(listing.id);
    await client.query(
      "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
      [sellerChatId, JSON.stringify(state)]
    );
    await client.query("COMMIT");
    return { ok: true, listing: { ...listing, asking_price: input.askingPrice, vehicle_uid: car.vehicleUid, vehicle_snapshot: vehicleSnapshot(car) } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cancelMarketplaceListing(pool, input) {
  const sellerChatId = String(input?.sellerChatId ?? "");
  const listingId = String(input?.listingId ?? "");
  if (!sellerChatId.trim()) throw marketplaceError("INVALID_SELLER", "Seller account is required");
  if (!UUID_RE.test(listingId)) throw marketplaceError("INVALID_LISTING_ID", "Listing ID is invalid");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const listingResult = await client.query(
      "SELECT id,vehicle_uid,seller_chat_id,status FROM autonomous_marketplace_listings WHERE id=$1::uuid FOR UPDATE",
      [listingId]
    );
    if (!listingResult.rowCount) throw marketplaceError("LISTING_NOT_FOUND", "Listing was not found");
    const listing = listingResult.rows[0];
    if (String(listing.seller_chat_id) !== sellerChatId) {
      throw marketplaceError("NOT_SELLER", "Only the listing owner can cancel it");
    }
    if (listing.status !== "active") throw marketplaceError("LISTING_NOT_ACTIVE", "Listing is no longer active");

    const stateResult = await client.query(
      "SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",
      [sellerChatId]
    );
    if (!stateResult.rowCount) throw marketplaceError("PROFILE_NOT_FOUND", "Seller profile was not found");
    const state = stateResult.rows[0].state;
    state.garage = Array.isArray(state.garage) ? state.garage : [];
    const car = state.garage.find(item =>
      String(item.vehicleUid) === String(listing.vehicle_uid) &&
      String(item.marketplaceListingId || "") === listingId
    );
    if (!car) throw marketplaceError("LISTING_STATE_MISMATCH", "The listed vehicle lock could not be verified; no changes were made");

    delete car.marketplaceListingId;
    await client.query(
      "UPDATE autonomous_marketplace_listings SET status='cancelled',updated_at=now() WHERE id=$1::uuid AND status='active'",
      [listingId]
    );
    await client.query(
      "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
      [sellerChatId, JSON.stringify(state)]
    );
    await client.query("COMMIT");
    return { ok: true, listingId, vehicleUid: String(listing.vehicle_uid) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function expireMarketplaceListings(pool, { batchSize = 50 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw marketplaceError("INVALID_BATCH_SIZE", "Expiry batch size must be between 1 and 500");
  }
  const expired = [];
  for (let index = 0; index < batchSize; index += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const listingResult = await client.query(
        "SELECT id,vehicle_uid,seller_chat_id,status FROM autonomous_marketplace_listings " +
        "WHERE status='active' AND expires_at<=now() ORDER BY expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED"
      );
      if (!listingResult.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const listing = listingResult.rows[0];
      const stateResult = await client.query(
        "SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",
        [String(listing.seller_chat_id)]
      );
      if (stateResult.rowCount) {
        const state = stateResult.rows[0].state;
        state.garage = Array.isArray(state.garage) ? state.garage : [];
        const car = state.garage.find(item =>
          String(item.vehicleUid) === String(listing.vehicle_uid) &&
          String(item.marketplaceListingId || "") === String(listing.id)
        );
        if (car) {
          delete car.marketplaceListingId;
          await client.query(
            "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
            [String(listing.seller_chat_id), JSON.stringify(state)]
          );
        }
      }
      await client.query(
        "UPDATE autonomous_marketplace_listings SET status='expired',updated_at=now() WHERE id=$1::uuid AND status='active'",
        [String(listing.id)]
      );
      await client.query("COMMIT");
      expired.push(String(listing.id));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { ok: true, expiredCount: expired.length, listingIds: expired };
}

module.exports = {
  MAX_PRICE,
  MAX_EXPIRY_HOURS,
  validateListingInput,
  vehicleSnapshot,
  createMarketplaceListing,
  cancelMarketplaceListing,
  expireMarketplaceListings
};
