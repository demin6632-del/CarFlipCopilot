"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const marketplace = require("./player-marketplace-listings");

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL or DATABASE_URL is required for marketplace PostgreSQL integration tests");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 6
});

async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
}

(async () => {
  const suffix = crypto.randomUUID();
  const seller = "market-test-seller-" + suffix;
  const other = "market-test-other-" + suffix;
  const vehicleUid = crypto.randomUUID();
  const plate = "А" + String(100 + Math.floor(Math.random() * 900)) + "ВС " + String(10 + Math.floor(Math.random() * 90));
  const listingIds = [];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomous_game_state (
        chat_id text PRIMARY KEY,
        version integer NOT NULL DEFAULT 1,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      INSERT INTO vehicle_plate_registry(plate,vehicle_uid,owner_chat_id,source)
      VALUES($1,$2::uuid,$3,'marketplace-integration-test')
    `, [plate, vehicleUid, seller]);

    const sellerState = {
      player: { balance: 3000000 },
      garage: [{
        id: "test-car-" + suffix, vehicleUid, plate,
        model: "Integration Test Car", catalogId: "test_car", year: 2020,
        mileage: 40000, condition: 95, damage: 0
      }]
    };
    await pool.query(
      "INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,1,$2::jsonb)",
      [seller, JSON.stringify(sellerState)]
    );

    await test("PostgreSQL listing creation commits the listing and vehicle lock atomically", async () => {
      const result = await marketplace.createMarketplaceListing(pool, {
        sellerChatId: seller, vehicleId: sellerState.garage[0].id, askingPrice: 950000
      });
      listingIds.push(result.listing.id);
      const state = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      const listing = await pool.query("SELECT * FROM autonomous_marketplace_listings WHERE id=$1::uuid", [result.listing.id]);
      assert.equal(state.rows[0].state.garage[0].marketplaceListingId, result.listing.id);
      assert.equal(listing.rowCount, 1);
      assert.equal(listing.rows[0].status, "active");
      assert.equal(Number(listing.rows[0].asking_price), 950000);
      assert.equal(listing.rows[0].vehicle_uid, vehicleUid);
    });

    await test("concurrent duplicate listing requests create exactly one active listing", async () => {
      const state = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      delete state.rows[0].state.garage[0].marketplaceListingId;
      await pool.query("UPDATE autonomous_game_state SET state=$2::jsonb WHERE chat_id=$1", [seller, JSON.stringify(state.rows[0].state)]);
      await pool.query("UPDATE autonomous_marketplace_listings SET status='cancelled' WHERE vehicle_uid=$1::uuid AND status='active'", [vehicleUid]);
      const results = await Promise.allSettled([
        marketplace.createMarketplaceListing(pool, { sellerChatId: seller, vehicleId: sellerState.garage[0].id, askingPrice: 960000 }),
        marketplace.createMarketplaceListing(pool, { sellerChatId: seller, vehicleId: sellerState.garage[0].id, askingPrice: 970000 })
      ]);
      const successes = results.filter(result => result.status === "fulfilled");
      assert.equal(successes.length, 1);
      const active = await pool.query("SELECT id FROM autonomous_marketplace_listings WHERE vehicle_uid=$1::uuid AND status='active'", [vehicleUid]);
      assert.equal(active.rowCount, 1);
      listingIds.push(active.rows[0].id);
    });

    await test("only the seller can cancel; cancellation retains history and unlocks the car", async () => {
      const active = await pool.query("SELECT id FROM autonomous_marketplace_listings WHERE vehicle_uid=$1::uuid AND status='active'", [vehicleUid]);
      const listingId = active.rows[0].id;
      await assert.rejects(
        () => marketplace.cancelMarketplaceListing(pool, { sellerChatId: other, listingId }),
        error => error.code === "NOT_SELLER"
      );
      const denied = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [listingId]);
      assert.equal(denied.rows[0].status, "active");
      await marketplace.cancelMarketplaceListing(pool, { sellerChatId: seller, listingId });
      const cancelled = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [listingId]);
      const state = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      assert.equal(cancelled.rows[0].status, "cancelled");
      assert.equal("marketplaceListingId" in state.rows[0].state.garage[0], false);
    });

    await test("expired listings atomically unlock the seller's vehicle in PostgreSQL", async () => {
      const created = await marketplace.createMarketplaceListing(pool, {
        sellerChatId: seller, vehicleId: sellerState.garage[0].id, askingPrice: 980000
      });
      listingIds.push(created.listing.id);
      await pool.query(
        "UPDATE autonomous_marketplace_listings SET created_at=now()-interval '2 minutes', expires_at=now()-interval '1 minute' WHERE id=$1::uuid",
        [created.listing.id]
      );
      const result = await marketplace.expireMarketplaceListings(pool, { batchSize: 5 });
      assert.ok(result.listingIds.includes(created.listing.id));
      const listing = await pool.query("SELECT status FROM autonomous_marketplace_listings WHERE id=$1::uuid", [created.listing.id]);
      const state = await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1", [seller]);
      assert.equal(listing.rows[0].status, "expired");
      assert.equal("marketplaceListingId" in state.rows[0].state.garage[0], false);
    });

    await test("a copied vehicle UID owned by another account is rejected", async () => {
      const copiedState = {
        garage: [{
          id: "copied-" + suffix, vehicleUid, plate,
          model: "Copied vehicle", year: 2020, mileage: 1, condition: 100, damage: 0
        }]
      };
      await pool.query(
        "INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,1,$2::jsonb)",
        [other, JSON.stringify(copiedState)]
      );
      await assert.rejects(
        () => marketplace.createMarketplaceListing(pool, { sellerChatId: other, vehicleId: copiedState.garage[0].id, askingPrice: 1 }),
        error => error.code === "REGISTRY_OWNERSHIP_MISMATCH"
      );
    });

    console.log("Player marketplace PostgreSQL integration: OK");
  } finally {
    await pool.query("DELETE FROM autonomous_marketplace_listings WHERE seller_chat_id = ANY($1::text[])", [[seller, other]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_game_state WHERE chat_id = ANY($1::text[])", [[seller, other]]).catch(() => {});
    await pool.query("DELETE FROM vehicle_plate_registry WHERE vehicle_uid=$1::uuid", [vehicleUid]).catch(() => {});
    await pool.end();
  }
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
