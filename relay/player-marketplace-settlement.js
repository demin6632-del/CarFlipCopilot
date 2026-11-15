"use strict";

const { randomUUID } = require("node:crypto");
const { transferVehicleOwner } = require("./vehicle-plate-registry");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRICE = 1000000000000;

function settlementError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeMoney(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw settlementError("INVALID_BALANCE", "Player balance is not a safe whole-ruble amount");
  }
  return number;
}

/**
 * Settle one fixed-price player listing. Requires the additive settlement
 * migration and the PR #45 global vehicle registry.
 *
 * Lock order is always player states (ascending chat_id), then listing,
 * then registry row. The callback receipt, both player states, both ledger
 * rows, registry ownership and listing status commit in one transaction.
 */
async function purchaseMarketplaceListing(pool, input) {
  const buyerChatId = String(input?.buyerChatId ?? "").trim();
  const listingId = String(input?.listingId ?? "");
  const callbackId = String(input?.callbackId ?? "").trim();
  const expectedPrice = input?.expectedPrice == null ? null : Number(input.expectedPrice);
  if (expectedPrice !== null && (!Number.isSafeInteger(expectedPrice) || expectedPrice <= 0 || expectedPrice > MAX_PRICE)) {
    throw settlementError("INVALID_EXPECTED_PRICE", "Expected listing price is invalid");
  }
  if (!buyerChatId) throw settlementError("INVALID_BUYER", "Buyer account is required");
  if (!UUID_RE.test(listingId)) throw settlementError("INVALID_LISTING_ID", "Listing ID is invalid");
  if (!callbackId || callbackId.length > 256) {
    throw settlementError("INVALID_CALLBACK", "A valid Telegram callback ID is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Preview only identifies the seller so both state rows can be locked in
    // deterministic order. The listing is re-read FOR UPDATE after state locks.
    const preview = await client.query(
      "SELECT seller_chat_id FROM autonomous_marketplace_listings WHERE id=$1::uuid",
      [listingId]
    );
    if (!preview.rowCount) throw settlementError("LISTING_NOT_FOUND", "Listing was not found");
    const sellerChatId = String(preview.rows[0].seller_chat_id);
    if (sellerChatId === buyerChatId) throw settlementError("SELF_PURCHASE", "You cannot buy your own vehicle");

    const accountIds = [buyerChatId, sellerChatId].sort();
    const statesResult = await client.query(
      "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id = ANY($1::text[]) ORDER BY chat_id FOR UPDATE",
      [accountIds]
    );
    const states = new Map(statesResult.rows.map(row => [String(row.chat_id), row.state]));
    if (!states.has(buyerChatId) || !states.has(sellerChatId)) {
      throw settlementError("PROFILE_NOT_FOUND", "Buyer or seller profile was not found");
    }

    const listingResult = await client.query(
      "SELECT id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at " +
      "FROM autonomous_marketplace_listings WHERE id=$1::uuid FOR UPDATE",
      [listingId]
    );
    if (!listingResult.rowCount) throw settlementError("LISTING_NOT_FOUND", "Listing was not found");
    const listing = listingResult.rows[0];
    if (String(listing.seller_chat_id) !== sellerChatId) {
      throw settlementError("LISTING_CHANGED", "Listing seller changed; retry from the marketplace");
    }
    const receipt = await client.query(
      "INSERT INTO autonomous_processed_callbacks(chat_id,callback_id) VALUES($1,$2) " +
      "ON CONFLICT DO NOTHING RETURNING callback_id",
      [buyerChatId, callbackId]
    );
    if (!receipt.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, duplicate: true };
    }
    if (listing.status !== "active" || new Date(listing.expires_at).getTime() <= Date.now()) {
      throw settlementError("LISTING_NOT_ACTIVE", "This listing is no longer available");
    }

    const buyer = states.get(buyerChatId);
    const seller = states.get(sellerChatId);
    buyer.player = buyer.player || {};
    seller.player = seller.player || {};
    buyer.garage = Array.isArray(buyer.garage) ? buyer.garage : [];
    seller.garage = Array.isArray(seller.garage) ? seller.garage : [];
    buyer.transactions = Array.isArray(buyer.transactions) ? buyer.transactions : [];
    seller.transactions = Array.isArray(seller.transactions) ? seller.transactions : [];

    const price = Number(listing.asking_price);
    if (!Number.isSafeInteger(price) || price <= 0 || price > MAX_PRICE) {
      throw settlementError("INVALID_LISTING_PRICE", "Listing price is invalid");
    }
    if (expectedPrice !== null && price !== expectedPrice) {
      throw settlementError("PRICE_CHANGED", "Listing price changed after the confirmation screen was opened");
    }
    const buyerBalance = safeMoney(buyer.player.balance);
    const sellerBalance = safeMoney(seller.player.balance);
    if (!Number.isSafeInteger(sellerBalance + price)) {
      throw settlementError("BALANCE_OVERFLOW", "Seller balance would exceed the safe accounting range");
    }
    const capacity = Number.isInteger(buyer.player.garageCapacity) && buyer.player.garageCapacity > 0
      ? buyer.player.garageCapacity : 3;
    if (buyerBalance < price) throw settlementError("INSUFFICIENT_FUNDS", "Not enough funds to buy this vehicle");
    if (buyer.garage.length >= capacity) throw settlementError("GARAGE_FULL", "Buyer garage is full");
    if (buyer.garage.some(car => String(car.vehicleUid) === String(listing.vehicle_uid))) {
      throw settlementError("DUPLICATE_VEHICLE", "Buyer already owns this vehicle");
    }

    const carIndex = seller.garage.findIndex(car =>
      String(car.vehicleUid) === String(listing.vehicle_uid) &&
      String(car.marketplaceListingId || "") === listingId
    );
    if (carIndex < 0) throw settlementError("SELLER_VEHICLE_MISSING", "Seller no longer owns the listed vehicle");
    const car = seller.garage[carIndex];
    if (!car.plate || !car.vehicleUid) {
      throw settlementError("VEHICLE_REGISTRY_MISMATCH", "Vehicle identity is incomplete");
    }

    // The registry is authoritative. Ownership transfer is compare-and-set;
    // a mismatch aborts the entire purchase.
    const registry = await transferVehicleOwner(client, String(listing.vehicle_uid), sellerChatId, buyerChatId);
    if (String(registry.plate) !== String(car.plate)) {
      throw settlementError("VEHICLE_REGISTRY_MISMATCH", "Vehicle plate does not match the global registry");
    }

    seller.garage.splice(carIndex, 1);
    delete car.marketplaceListingId;
    buyer.garage.push(car);
    buyer.player.balance = buyerBalance - price;
    seller.player.balance = sellerBalance + price;

    const buyerTxId = randomUUID();
    const sellerTxId = randomUUID();
    const now = Date.now();
    buyer.transactions.unshift({
      id: buyerTxId, ledgerPersisted: true, time: now, kind: "marketplace_purchase", amount: -price,
      balance: buyer.player.balance, description: "Покупка автомобиля на общем рынке"
    });
    seller.transactions.unshift({
      id: sellerTxId, ledgerPersisted: true, time: now, kind: "marketplace_sale", amount: price,
      balance: seller.player.balance, description: "Продажа автомобиля на общем рынке"
    });
    buyer.transactions = buyer.transactions.slice(0, 80);
    seller.transactions = seller.transactions.slice(0, 80);

    await client.query(
      "INSERT INTO autonomous_economy_ledger(transaction_id,chat_id,kind,amount,balance_after,description,occurred_at) " +
      "VALUES($1::uuid,$2,'marketplace_purchase',$3,$4,$5,to_timestamp($6::double precision/1000.0)), " +
      "($7::uuid,$8,'marketplace_sale',$9,$10,$11,to_timestamp($6::double precision/1000.0))",
      [buyerTxId, buyerChatId, -price, buyer.player.balance, "Покупка автомобиля на общем рынке", now,
       sellerTxId, sellerChatId, price, seller.player.balance, "Продажа автомобиля на общем рынке"]
    );

    await client.query(
      "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
      [sellerChatId, JSON.stringify(seller)]
    );
    await client.query(
      "UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",
      [buyerChatId, JSON.stringify(buyer)]
    );
    await client.query(
      "UPDATE autonomous_marketplace_listings SET status='sold',sold_to_chat_id=$2,sold_at=now(),updated_at=now() " +
      "WHERE id=$1::uuid AND status='active'",
      [listingId, buyerChatId]
    );
    await client.query(
      "INSERT INTO autonomous_marketplace_transactions(listing_id,vehicle_uid,buyer_chat_id,seller_chat_id,gross_amount,fee_amount,net_amount) " +
      "VALUES($1::uuid,$2::uuid,$3,$4,$5,0,$5)",
      [listingId, String(listing.vehicle_uid), buyerChatId, sellerChatId, price]
    );

    await client.query("COMMIT");
    return {
      ok: true, listingId, vehicleUid: String(listing.vehicle_uid),
      model: String(car.model || listing.vehicle_snapshot?.model || "Автомобиль"),
      plate: String(registry.plate), price, sellerChatId,
      buyerBalance: buyer.player.balance, sellerBalance: seller.player.balance
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { purchaseMarketplaceListing };
