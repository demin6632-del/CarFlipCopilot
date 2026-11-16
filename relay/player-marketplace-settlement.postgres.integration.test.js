"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { purchaseMarketplaceListing } = require("./player-marketplace-settlement");
const { cancelMarketplaceListing, expireMarketplaceListings } = require("./player-marketplace-listings");
const game = require("./autonomous-game");

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL or DATABASE_URL is required for settlement PostgreSQL integration tests");
  process.exit(1);
}
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 8
});

async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
}

(async () => {
  const suffix = crypto.randomUUID();
  const seller = "settlement-seller-" + suffix;
  const buyerA = "settlement-buyer-a-" + suffix;
  const buyerB = "settlement-buyer-b-" + suffix;
  const vehicleUid = crypto.randomUUID();
  const listingId = crypto.randomUUID();
  const plate = "А" + String(100 + Math.floor(Math.random() * 900)) + "ВС " + String(10 + Math.floor(Math.random() * 90));
  const car = {
    id: "car-" + suffix, vehicleUid, plate, model: "Settlement Integration Car",
    catalogId: "settlement_test", year: 2021, mileage: 52000, condition: 94,
    damage: 1, vin: "TESTVIN" + suffix.replace(/-/g, "").slice(0, 10),
    tuning: { engine: "stock" }, history: [{ event: "first registration" }],
    marketplaceListingId: listingId
  };
  const sellerState = { player: { balance: 400000, garageCapacity: 3 }, garage: [car], transactions: [], meta: {} };
  const buyerState = id => ({ player: { balance: 2000000, garageCapacity: 3 }, garage: [], transactions: [], meta: {} });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomous_game_state (
        chat_id text PRIMARY KEY,
        version integer NOT NULL DEFAULT 1,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-integration-test')",
      [plate, vehicleUid, seller]
    );
    await pool.query(
      "INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,1,$2::jsonb),($3,1,$4::jsonb),($5,1,$6::jsonb)",
      [seller, JSON.stringify(sellerState), buyerA, JSON.stringify(buyerState(buyerA)), buyerB, JSON.stringify(buyerState(buyerB))]
    );
    await pool.query(
      "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
      "VALUES($1::uuid,$2::uuid,$3,850000,'active',$4::jsonb,now()+interval '1 day')",
      [listingId, vehicleUid, seller, JSON.stringify({ model: car.model, plate, year: 2021, mileage: 52000, condition: 94, damage: 1 })]
    );

    await test("PostgreSQL settlement rejects a stale confirmation price without changing state", async () => {
      await assert.rejects(
        () => purchaseMarketplaceListing(pool, {
          buyerChatId: buyerA, listingId, callbackId: "stale-confirm-" + suffix, expectedPrice: 849999
        }),
        error => error.code === "PRICE_CHANGED"
      );
      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerA]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(buyerA).player.balance, 2000000);
      assert.equal(byId.get(seller).player.balance, 400000);
      assert.equal(byId.get(seller).garage[0].vehicleUid, vehicleUid);
      const listing = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [listingId]);
      assert.equal(listing.rows[0].status, "active");
      const registry = await pool.query("SELECT owner_chat_id FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [vehicleUid]);
      assert.equal(registry.rows[0].owner_chat_id, seller);
      const receipt = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_processed_callbacks WHERE chat_id=$1 AND callback_id=$2",
        [buyerA, "stale-confirm-" + suffix]
      );
      assert.equal(receipt.rows[0].count, 0);
    });

    await test("PostgreSQL settlement moves the exact vehicle and reconciles both balances and ledger", async () => {
      const result = await purchaseMarketplaceListing(pool, {
        buyerChatId: buyerA, listingId, callbackId: "pg-settlement-" + suffix
      });
      assert.equal(result.ok, true);
      assert.equal(result.sellerChatId, seller, "settlement returns seller ID only to its private caller");
      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerA]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(buyerA).player.balance >= 0, true);
      assert.equal(byId.get(seller).player.balance >= 0, true);
      assert.equal(byId.get(buyerA).garage.length, 1);
      assert.equal(byId.get(seller).garage.length, 0);
      assert.equal(byId.get(buyerA).garage[0].vehicleUid, vehicleUid);
      assert.equal(byId.get(buyerA).garage[0].plate, plate);
      assert.equal(byId.get(buyerA).garage[0].vin, car.vin);
      assert.deepEqual(byId.get(buyerA).garage[0].tuning, car.tuning);
      assert.deepEqual(byId.get(buyerA).garage[0].history, car.history);
      assert.equal("marketplaceListingId" in byId.get(buyerA).garage[0], false);

      const registry = await pool.query("SELECT owner_chat_id,plate FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [vehicleUid]);
      assert.equal(registry.rows[0].owner_chat_id, buyerA);
      assert.equal(registry.rows[0].plate, plate);

      // Reconcile both profiles after the ownership transfer. The seller's
      // stale historical plate must not retire the buyer's active registry row.
      await game.load(seller, "Settlement Seller");
      const buyerReloaded = await game.load(buyerA, "Settlement Buyer");
      assert.equal(buyerReloaded.garage.length, 1);
      assert.equal(buyerReloaded.garage[0].vehicleUid, vehicleUid);
      assert.equal(buyerReloaded.garage[0].plate, plate);
      const registryAfterReload = await pool.query(
        "SELECT owner_chat_id,plate,retired_at FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid",
        [vehicleUid]
      );
      assert.equal(registryAfterReload.rows[0].owner_chat_id, buyerA);
      assert.equal(registryAfterReload.rows[0].plate, plate);
      assert.equal(registryAfterReload.rows[0].retired_at, null);

      const listing = await pool.query("SELECT status,sold_to_chat_id FROM autonomous_marketplace_listings WHERE id=$1::uuid", [listingId]);
      assert.equal(listing.rows[0].status, "sold");
      assert.equal(listing.rows[0].sold_to_chat_id, buyerA);
      const ledger = await pool.query("SELECT chat_id,kind,amount,balance_after FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[]) AND kind IN ('marketplace_purchase','marketplace_sale')", [[buyerA, seller]]);
      assert.equal(ledger.rowCount, 2);
      await assert.rejects(
        pool.query("UPDATE autonomous_economy_ledger SET amount=0 WHERE chat_id=$1 AND kind='marketplace_purchase'", [buyerA]),
        /autonomous_economy_ledger is append-only/
      );
      await assert.rejects(
        pool.query("DELETE FROM autonomous_economy_ledger WHERE chat_id=$1 AND kind='marketplace_sale'", [seller]),
        /autonomous_economy_ledger is append-only/
      );
      const immutableLedger = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[]) AND kind IN ('marketplace_purchase','marketplace_sale')",
        [[buyerA, seller]]
      );
      assert.equal(immutableLedger.rows[0].count, 2);
      assert.deepEqual(ledger.rows.map(row => [row.chat_id, Number(row.amount), Number(row.balance_after)]).sort((a,b)=>a[0].localeCompare(b[0])), [
        [buyerA, -850000, 1150000], [seller, 850000, 1250000]
      ].sort((a,b)=>a[0].localeCompare(b[0])));
      const history = await pool.query("SELECT count(*)::int AS count FROM autonomous_marketplace_transactions WHERE listing_id=$1::uuid", [listingId]);
      assert.equal(history.rows[0].count, 1);

      const replay = await purchaseMarketplaceListing(pool, {
        buyerChatId: buyerA, listingId, callbackId: "pg-settlement-" + suffix
      });
      assert.deepEqual(replay, { ok: false, duplicate: true });
      const replayStates = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerA]]
      );
      const replayById = new Map(replayStates.rows.map(row => [row.chat_id, row.state]));
      assert.equal(replayById.get(buyerA).player.balance, 1150000);
      assert.equal(replayById.get(seller).player.balance, 1250000);
      assert.equal(replayById.get(buyerA).garage.length, 1);
      const replayLedger = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[]) AND kind IN ('marketplace_purchase','marketplace_sale')",
        [[buyerA, seller]]
      );
      assert.equal(replayLedger.rows[0].count, 2);
    });

    await test("PostgreSQL recovers a committed purchase when the COMMIT acknowledgement is lost", async () => {
      const recoveryUid = crypto.randomUUID();
      const recoveryListing = crypto.randomUUID();
      const recoveryPlate = "К" + String(100 + Math.floor(Math.random() * 900)) + "РС " + String(10 + Math.floor(Math.random() * 90));
      const recoveryCar = {
        id: "commit-recovery-car-" + suffix, vehicleUid: recoveryUid, plate: recoveryPlate,
        model: "Commit Recovery Integration Car", year: 2025, mileage: 800, condition: 100,
        marketplaceListingId: recoveryListing
      };
      const sellerBefore = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const buyerBefore = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [buyerB]);
      const sellerState = sellerBefore.rows[0].state;
      sellerState.garage.push(recoveryCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(sellerState)]);
      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'commit-recovery-test')",
        [recoveryPlate, recoveryUid, seller]
      );
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,225000,'active',$4::jsonb,now()+interval '1 day')",
        [recoveryListing, recoveryUid, seller, JSON.stringify({ model: recoveryCar.model, plate: recoveryPlate, year: 2025, mileage: 800, condition: 100, damage: 0 })]
      );

      const callbackId = "commit-ack-lost-" + suffix;
      const acknowledgementLossPool = {
        query: (...args) => pool.query(...args),
        connect: async () => {
          const client = await pool.connect();
          // Wrap the client instead of replacing client.query itself. The real
          // pool may reuse this client after release; mutating it would make
          // later, unrelated transactions inherit the simulated lost ACK.
          return {
            query: async (sql, params) => {
              const result = await client.query(sql, params);
              if (sql === "COMMIT") throw new Error("simulated lost COMMIT acknowledgement after server commit");
              return result;
            },
            release: () => client.release()
          };
        }
      };
      const result = await purchaseMarketplaceListing(acknowledgementLossPool, {
        buyerChatId: buyerB, listingId: recoveryListing, callbackId
      });
      assert.equal(result.ok, true);
      assert.equal(result.recovered, true);
      assert.equal(result.sellerChatId, seller);
      assert.equal(result.plate, recoveryPlate);
      assert.equal(result.price, 225000);

      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerB]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(buyerB).player.balance, buyerBefore.rows[0].state.player.balance - 225000);
      assert.equal(byId.get(seller).player.balance, sellerBefore.rows[0].state.player.balance + 225000);
      assert.equal(byId.get(buyerB).garage.filter(item => item.vehicleUid === recoveryUid).length, 1);
      assert.equal(byId.get(seller).garage.some(item => item.vehicleUid === recoveryUid), false);
      const receipt = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_processed_callbacks WHERE chat_id=$1 AND callback_id=$2",
        [buyerB, callbackId]
      );
      assert.equal(receipt.rows[0].count, 1);
      const transaction = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_marketplace_transactions WHERE listing_id=$1::uuid",
        [recoveryListing]
      );
      assert.equal(transaction.rows[0].count, 1);
    });

    await test("two buyers racing for one listing cannot both complete the purchase", async () => {
      const secondUid = crypto.randomUUID();
      const secondListing = crypto.randomUUID();
      const secondPlate = "В" + String(100 + Math.floor(Math.random() * 900)) + "ЕК " + String(10 + Math.floor(Math.random() * 90));
      const secondCar = { ...car, id: "race-car-" + suffix, vehicleUid: secondUid, plate: secondPlate, marketplaceListingId: secondListing };
      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-race-test')",
        [secondPlate, secondUid, seller]
      );
      const currentSeller = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const nextSellerState = currentSeller.rows[0].state;
      nextSellerState.garage.push(secondCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(nextSellerState)]);
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,750000,'active',$4::jsonb,now()+interval '1 day')",
        [secondListing, secondUid, seller, JSON.stringify({ model: secondCar.model, plate: secondPlate, year: 2021, mileage: 52000, condition: 94, damage: 1 })]
      );

      const results = await Promise.allSettled([
        purchaseMarketplaceListing(pool, { buyerChatId: buyerA, listingId: secondListing, callbackId: "race-a-" + suffix }),
        purchaseMarketplaceListing(pool, { buyerChatId: buyerB, listingId: secondListing, callbackId: "race-b-" + suffix })
      ]);
      assert.equal(results.filter(item => item.status === "fulfilled" && item.value.ok).length, 1);
      assert.equal(results.filter(item => item.status === "rejected").length, 1);
      const listing = await pool.query("SELECT status,sold_to_chat_id FROM autonomous_marketplace_listings WHERE id=$1::uuid", [secondListing]);
      assert.equal(listing.rows[0].status, "sold");
      const count = await pool.query("SELECT count(*)::int AS count FROM autonomous_marketplace_transactions WHERE listing_id=$1::uuid", [secondListing]);
      assert.equal(count.rows[0].count, 1);
      const owners = await pool.query("SELECT owner_chat_id FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [secondUid]);
      assert.equal(owners.rows[0].owner_chat_id, listing.rows[0].sold_to_chat_id);
    });



    await test("concurrent replay of the same purchase callback settles only once", async () => {
      const raceUid = crypto.randomUUID();
      const raceListing = crypto.randomUUID();
      const racePlate = "С" + String(100 + Math.floor(Math.random() * 900)) + "МН " + String(10 + Math.floor(Math.random() * 90));
      const raceCar = {
        id: "callback-race-car-" + suffix, vehicleUid: raceUid, plate: racePlate,
        model: "Concurrent Callback Race Car", year: 2024, mileage: 2500, condition: 100,
        marketplaceListingId: raceListing
      };
      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-callback-race-test')",
        [racePlate, raceUid, seller]
      );
      const ledgerBefore = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[]) AND kind IN ('marketplace_purchase','marketplace_sale')",
        [[seller, buyerB]]
      );
      const beforeStates = await pool.query("SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])", [[seller, buyerB]]);
      const beforeById = new Map(beforeStates.rows.map(row => [row.chat_id, row.state]));
      const sellerBalanceBefore = beforeById.get(seller).player.balance;
      const buyerBalanceBefore = beforeById.get(buyerB).player.balance;
      const currentSeller = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const nextSellerState = currentSeller.rows[0].state;
      nextSellerState.garage.push(raceCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(nextSellerState)]);
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,175000,'active',$4::jsonb,now()+interval '1 day')",
        [raceListing, raceUid, seller, JSON.stringify({ model: raceCar.model, plate: racePlate, year: 2024, mileage: 2500, condition: 100, damage: 0 })]
      );

      const callbackId = "same-callback-race-" + suffix;
      const results = await Promise.all([
        purchaseMarketplaceListing(pool, { buyerChatId: buyerB, listingId: raceListing, callbackId }),
        purchaseMarketplaceListing(pool, { buyerChatId: buyerB, listingId: raceListing, callbackId })
      ]);
      assert.equal(results.filter(result => result.ok === true).length, 1);
      assert.equal(results.filter(result => result.duplicate === true).length, 1);

      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerB]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(buyerB).player.balance, buyerBalanceBefore - 175000);
      assert.equal(byId.get(seller).player.balance, sellerBalanceBefore + 175000);
      assert.equal(byId.get(buyerB).garage.filter(item => item.vehicleUid === raceUid).length, 1);
      assert.equal(byId.get(seller).garage.some(item => item.vehicleUid === raceUid), false);
      const listing = await pool.query("SELECT status,sold_to_chat_id FROM autonomous_marketplace_listings WHERE id=$1::uuid", [raceListing]);
      assert.equal(listing.rows[0].status, "sold");
      assert.equal(listing.rows[0].sold_to_chat_id, buyerB);
      const ledger = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[]) AND kind IN ('marketplace_purchase','marketplace_sale')",
        [[seller, buyerB]]
      );
      assert.equal(ledger.rows[0].count, ledgerBefore.rows[0].count + 2);
      const history = await pool.query("SELECT count(*)::int AS count FROM autonomous_marketplace_transactions WHERE listing_id=$1::uuid", [raceListing]);
      assert.equal(history.rows[0].count, 1);
      const receipt = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_processed_callbacks WHERE chat_id=$1 AND callback_id=$2",
        [buyerB, callbackId]
      );
      assert.equal(receipt.rows[0].count, 1);
    });

    await test("purchase racing seller cancellation produces exactly one consistent outcome", async () => {
      const raceUid = crypto.randomUUID();
      const raceListing = crypto.randomUUID();
      const racePlate = "Е" + String(100 + Math.floor(Math.random() * 900)) + "КХ " + String(10 + Math.floor(Math.random() * 90));
      const raceCar = {
        id: "cancel-race-car-" + suffix, vehicleUid: raceUid, plate: racePlate,
        model: "Cancellation Race Car", year: 2022, mileage: 12000, condition: 99,
        marketplaceListingId: raceListing
      };
      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-cancel-race-test')",
        [racePlate, raceUid, seller]
      );
      const currentSeller = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const nextSellerState = currentSeller.rows[0].state;
      nextSellerState.garage.push(raceCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(nextSellerState)]);
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,250000,'active',$4::jsonb,now()+interval '1 day')",
        [raceListing, raceUid, seller, JSON.stringify({ model: raceCar.model, plate: racePlate, year: 2022, mileage: 12000, condition: 99, damage: 0 })]
      );

      const outcomes = await Promise.allSettled([
        purchaseMarketplaceListing(pool, { buyerChatId: buyerA, listingId: raceListing, callbackId: "cancel-race-buy-" + suffix }),
        cancelMarketplaceListing(pool, { sellerChatId: seller, listingId: raceListing })
      ]);
      const purchaseWon = outcomes[0].status === "fulfilled" && outcomes[0].value.ok === true;
      const cancelWon = outcomes[1].status === "fulfilled" && outcomes[1].value.ok === true;
      assert.equal(Number(purchaseWon) + Number(cancelWon), 1);

      const listing = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [raceListing]);
      const registry = await pool.query("SELECT owner_chat_id FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [raceUid]);
      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerA]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      if (purchaseWon) {
        assert.equal(listing.rows[0].status, "sold");
        assert.equal(registry.rows[0].owner_chat_id, buyerA);
        assert.equal(byId.get(buyerA).garage.some(item => item.vehicleUid === raceUid && !item.marketplaceListingId), true);
        assert.equal(byId.get(seller).garage.some(item => item.vehicleUid === raceUid), false);
      } else {
        assert.equal(listing.rows[0].status, "cancelled");
        assert.equal(registry.rows[0].owner_chat_id, seller);
        assert.equal(byId.get(seller).garage.some(item => item.vehicleUid === raceUid && !item.marketplaceListingId), true);
        assert.equal(byId.get(buyerA).garage.some(item => item.vehicleUid === raceUid), false);
      }
    });


    await test("expired-listing worker racing a purchase never transfers an expired vehicle", async () => {
      const raceUid = crypto.randomUUID();
      const raceListing = crypto.randomUUID();
      const racePlate = "Н" + String(100 + Math.floor(Math.random() * 900)) + "ОР " + String(10 + Math.floor(Math.random() * 90));
      const raceCar = {
        id: "expiry-race-car-" + suffix, vehicleUid: raceUid, plate: racePlate,
        model: "Expiry Race Car", year: 2023, mileage: 5000, condition: 100,
        marketplaceListingId: raceListing
      };
      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-expiry-race-test')",
        [racePlate, raceUid, seller]
      );
      const currentSeller = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const nextSellerState = currentSeller.rows[0].state;
      nextSellerState.garage.push(raceCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(nextSellerState)]);
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,created_at,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,300000,'active',$4::jsonb,now()-interval '2 days',now()-interval '1 second')",
        [raceListing, raceUid, seller, JSON.stringify({ model: raceCar.model, plate: racePlate, year: 2023, mileage: 5000, condition: 100, damage: 0 })]
      );

      const balanceSnapshot = new Map((await pool.query("SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])", [[seller, buyerA]])).rows.map(row => [row.chat_id, row.state.player.balance]));
      const outcomes = await Promise.allSettled([
        purchaseMarketplaceListing(pool, { buyerChatId: buyerA, listingId: raceListing, callbackId: "expiry-race-buy-" + suffix }),
        expireMarketplaceListings(pool, { batchSize: 1 })
      ]);
      assert.equal(outcomes[0].status, "rejected");
      assert.equal(outcomes[1].status, "fulfilled");
      const listing = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [raceListing]);
      const registry = await pool.query("SELECT owner_chat_id FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [raceUid]);
      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerA]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(buyerA).player.balance, balanceSnapshot.get(buyerA));
      assert.equal(byId.get(seller).player.balance, balanceSnapshot.get(seller));
      assert.equal(listing.rows[0].status, "expired");
      assert.equal(registry.rows[0].owner_chat_id, seller);
      assert.equal(byId.get(seller).garage.some(item => item.vehicleUid === raceUid && !item.marketplaceListingId), true);
      assert.equal(byId.get(buyerA).garage.some(item => item.vehicleUid === raceUid), false);
    });


    await test("settlement failure after registry transfer rolls back registry, balances, garages, listing and ledger", async () => {
      const rollbackUid = crypto.randomUUID();
      const rollbackListing = crypto.randomUUID();
      const rollbackPlate = "Р" + String(100 + Math.floor(Math.random() * 900)) + "ТУ " + String(10 + Math.floor(Math.random() * 90));
      const rollbackCar = {
        id: "rollback-car-" + suffix, vehicleUid: rollbackUid, plate: rollbackPlate,
        model: "Rollback Integration Car", year: 2024, mileage: 1000, condition: 100,
        marketplaceListingId: rollbackListing
      };
      const sellerBefore = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const buyerBefore = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [buyerB]);
      const sellerBalanceBefore = sellerBefore.rows[0].state.player.balance;
      const buyerBalanceBefore = buyerBefore.rows[0].state.player.balance;
      const sellerGarageBefore = sellerBefore.rows[0].state.garage.length;
      const buyerGarageBefore = buyerBefore.rows[0].state.garage.length;
      const ledgerBefore = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[])",
        [[seller, buyerB]]
      );
      const triggerSuffix = suffix.replace(/-/g, "");
      const functionName = "settlement_rollback_fail_" + triggerSuffix;
      const triggerName = "settlement_rollback_fail_trg_" + triggerSuffix;

      await pool.query(
        "INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source) VALUES($1,$2::uuid,$3,'settlement-rollback-test')",
        [rollbackPlate, rollbackUid, seller]
      );
      const sellerWithCar = sellerBefore.rows[0].state;
      sellerWithCar.garage.push(rollbackCar);
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(sellerWithCar)]);
      await pool.query(
        "INSERT INTO autonomous_marketplace_listings(id,vehicle_uid,seller_chat_id,asking_price,status,vehicle_snapshot,expires_at) " +
        "VALUES($1::uuid,$2::uuid,$3,125000,'active',$4::jsonb,now()+interval '1 day')",
        [rollbackListing, rollbackUid, seller, JSON.stringify({ model: rollbackCar.model, plate: rollbackPlate, year: 2024, mileage: 1000, condition: 100, damage: 0 })]
      );

      try {
        await pool.query(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $rollback$
          BEGIN
            IF NEW.listing_id = '${rollbackListing}'::uuid THEN
              RAISE EXCEPTION 'intentional settlement rollback integration failure';
            END IF;
            RETURN NEW;
          END;
          $rollback$
        `);
        await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON autonomous_marketplace_transactions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

        await assert.rejects(
          purchaseMarketplaceListing(pool, {
            buyerChatId: buyerB, listingId: rollbackListing, callbackId: "rollback-" + suffix
          }),
          /intentional settlement rollback integration failure/
        );
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON autonomous_marketplace_transactions`);
        await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      }

      const registry = await pool.query("SELECT owner_chat_id,plate FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [rollbackUid]);
      assert.equal(registry.rows[0].owner_chat_id, seller);
      assert.equal(registry.rows[0].plate, rollbackPlate);
      const listing = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [rollbackListing]);
      assert.equal(listing.rows[0].status, "active");
      const states = await pool.query(
        "SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[])",
        [[seller, buyerB]]
      );
      const byId = new Map(states.rows.map(row => [row.chat_id, row.state]));
      assert.equal(byId.get(seller).player.balance, sellerBalanceBefore);
      assert.equal(byId.get(buyerB).player.balance, buyerBalanceBefore);
      assert.equal(byId.get(seller).garage.length, sellerGarageBefore + 1);
      assert.equal(byId.get(buyerB).garage.length, buyerGarageBefore);
      const retainedCar = byId.get(seller).garage.find(item => item.vehicleUid === rollbackUid);
      assert.equal(retainedCar.marketplaceListingId, rollbackListing);
      const ledgerAfter = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[])",
        [[seller, buyerB]]
      );
      assert.equal(ledgerAfter.rows[0].count, ledgerBefore.rows[0].count);
      const history = await pool.query("SELECT count(*)::int AS count FROM autonomous_marketplace_transactions WHERE listing_id=$1::uuid", [rollbackListing]);
      assert.equal(history.rows[0].count, 0);
      const callback = await pool.query(
        "SELECT count(*)::int AS count FROM autonomous_processed_callbacks WHERE chat_id=$1 AND callback_id=$2",
        [buyerB, "rollback-" + suffix]
      );
      assert.equal(callback.rows[0].count, 0);
    });

    console.log("Player marketplace settlement PostgreSQL integration: OK");
  } finally {
    await pool.query("DELETE FROM autonomous_marketplace_transactions WHERE listing_id IN (SELECT id FROM autonomous_marketplace_listings WHERE seller_chat_id=$1)", [seller]).catch(() => {});
    await pool.query("DELETE FROM autonomous_marketplace_listings WHERE seller_chat_id=$1", [seller]).catch(() => {});
    await pool.query("DELETE FROM autonomous_economy_ledger WHERE chat_id=ANY($1::text[])", [[seller, buyerA, buyerB]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_processed_callbacks WHERE chat_id=ANY($1::text[])", [[seller, buyerA, buyerB]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_game_state WHERE chat_id=ANY($1::text[])", [[seller, buyerA, buyerB]]).catch(() => {});
    await pool.query("DELETE FROM vehicle_plate_registry WHERE owner_chat_id=ANY($1::text[]) OR vehicle_uid IN (SELECT vehicle_uid FROM autonomous_marketplace_listings WHERE seller_chat_id=$2)", [[seller, buyerA, buyerB], seller]).catch(() => {});
    await pool.end();
  }
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
