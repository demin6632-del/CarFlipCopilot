"use strict";

// CI regression run: validate listing creation, ownership, cancellation and expiry guards.

const assert = require("node:assert/strict");
const marketplace = require("./player-marketplace-listings");

const SELLER = "10001";
const OTHER = "20002";
const VEHICLE_UID = "11111111-1111-5111-8111-111111111111";
const LISTING_ID = "22222222-2222-5222-8222-222222222222";

class FakePool {
  constructor() {
    this.state = {
      garage: [{
        id: "car-1", vehicleUid: VEHICLE_UID, plate: "А123ВС 77",
        model: "Lada Vesta 1.6", catalogId: "vesta_2019", year: 2019,
        mileage: 65000, condition: 92, damage: 1
      }]
    };
    this.registry = { plate: "А123ВС 77", owner_chat_id: SELLER, retired_at: null };
    this.listings = new Map();
    this.nextId = LISTING_ID;
  }
  async connect() {
    const pool = this;
    return {
      snapshot: null,
      async query(sql, params = []) {
        if (sql === "BEGIN") {
          this.snapshot = {
            state: JSON.parse(JSON.stringify(pool.state)),
            listings: new Map([...pool.listings].map(([k,v]) => [k, JSON.parse(JSON.stringify(v))]))
          };
          return { rowCount: 0, rows: [] };
        }
        if (sql === "COMMIT") { this.snapshot = null; return { rowCount: 0, rows: [] }; }
        if (sql === "ROLLBACK") {
          if (this.snapshot) {
            pool.state = this.snapshot.state;
            pool.listings = this.snapshot.listings;
            this.snapshot = null;
          }
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("WHERE status='active' AND expires_at<=now()")) {
          const row = [...pool.listings.values()].find(x => x.status === "active" && new Date(x.expires_at).getTime() <= Date.now());
          return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        }
        if (sql.includes("SELECT state FROM autonomous_game_state")) {
          return { rowCount: 1, rows: [{ state: JSON.parse(JSON.stringify(pool.state)) }] };
        }
        if (sql.includes("SELECT plate, owner_chat_id, retired_at FROM vehicle_plate_registry")) {
          return { rowCount: 1, rows: [pool.registry] };
        }
        if (sql.includes("SELECT id FROM autonomous_marketplace_listings")) {
          const found = [...pool.listings.values()].find(x => x.vehicle_uid === params[0] && x.status === "active");
          return { rowCount: found ? 1 : 0, rows: found ? [{ id: found.id }] : [] };
        }
        if (sql.includes("INSERT INTO autonomous_marketplace_listings")) {
          const id = pool.nextId;
          const row = {
            id, vehicle_uid: params[0], seller_chat_id: params[1],
            asking_price: params[2], status: "active",
            vehicle_snapshot: JSON.parse(params[3]),
            created_at: new Date("2026-11-15T12:00:00Z"),
            expires_at: new Date("2026-11-22T12:00:00Z")
          };
          pool.listings.set(id, row);
          return { rowCount: 1, rows: [{ id, created_at: row.created_at, expires_at: row.expires_at }] };
        }
        if (sql.includes("UPDATE autonomous_game_state SET state=")) {
          assert.equal(params[0], SELLER);
          pool.state = JSON.parse(params[1]);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SELECT seller_chat_id FROM autonomous_marketplace_listings")) {
          const row = pool.listings.get(params[0]);
          return { rowCount: row ? 1 : 0, rows: row ? [{ seller_chat_id: row.seller_chat_id }] : [] };
        }
        if (sql.includes("SELECT id,vehicle_uid,seller_chat_id,status FROM autonomous_marketplace_listings")) {
          const row = pool.listings.get(params[0]);
          return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        }
        if (sql.includes("UPDATE autonomous_marketplace_listings SET status='expired'")) {
          const row = pool.listings.get(params[0]);
          if (row && row.status === "active") row.status = "expired";
          return { rowCount: row ? 1 : 0, rows: [] };
        }
        if (sql.includes("UPDATE autonomous_marketplace_listings SET status='cancelled'")) {
          const row = pool.listings.get(params[0]);
          if (row && row.status === "active") row.status = "cancelled";
          return { rowCount: row ? 1 : 0, rows: [] };
        }
        throw new Error("Unexpected SQL: " + sql);
      },
      release() {}
    };
  }
}

async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
}

(async () => {
  await test("listing creation locks the owned car and stores a sanitized snapshot", async () => {
    const pool = new FakePool();
    const result = await marketplace.createMarketplaceListing(pool, {
      sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000
    });
    assert.equal(result.ok, true);
    assert.equal(result.listing.id, LISTING_ID);
    assert.equal(pool.state.garage[0].marketplaceListingId, LISTING_ID);
    assert.equal(pool.listings.get(LISTING_ID).status, "active");
    assert.equal(pool.listings.get(LISTING_ID).vehicle_snapshot.model, "Lada Vesta 1.6");
    assert.equal("marketplaceListingId" in pool.listings.get(LISTING_ID).vehicle_snapshot, false);
  });

  await test("a second active listing for the same physical vehicle is rejected", async () => {
    const pool = new FakePool();
    await marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000 });
    await assert.rejects(
      () => marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 860000 }),
      error => error.code === "ALREADY_LISTED"
    );
  });

  await test("invalid prices and expiry windows are rejected before database access", async () => {
    const pool = new FakePool();
    await assert.rejects(() => marketplace.createMarketplaceListing(pool, {
      sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 0
    }), error => error.code === "INVALID_PRICE");
    await assert.rejects(() => marketplace.createMarketplaceListing(pool, {
      sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 1000, expiresInHours: 24 * 31
    }), error => error.code === "INVALID_EXPIRY");
  });

  await test("cancellation unlocks the same vehicle and retains listing history", async () => {
    const pool = new FakePool();
    await marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000 });
    const result = await marketplace.cancelMarketplaceListing(pool, { sellerChatId: SELLER, listingId: LISTING_ID });
    assert.equal(result.ok, true);
    assert.equal("marketplaceListingId" in pool.state.garage[0], false);
    assert.equal(pool.listings.get(LISTING_ID).status, "cancelled");
  });

  await test("another account cannot cancel the seller's listing", async () => {
    const pool = new FakePool();
    await marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000 });
    await assert.rejects(
      () => marketplace.cancelMarketplaceListing(pool, { sellerChatId: OTHER, listingId: LISTING_ID }),
      error => error.code === "NOT_SELLER"
    );
    assert.equal(pool.listings.get(LISTING_ID).status, "active");
    assert.equal(pool.state.garage[0].marketplaceListingId, LISTING_ID);
  });

  await test("unregistered or foreign-owned vehicles cannot be listed", async () => {
    const pool = new FakePool();
    pool.registry.owner_chat_id = OTHER;
    await assert.rejects(
      () => marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000 }),
      error => error.code === "REGISTRY_OWNERSHIP_MISMATCH"
    );
    assert.equal(pool.listings.size, 0);
    assert.equal("marketplaceListingId" in pool.state.garage[0], false);
  });

  await test("expired listings are closed and the seller's vehicle is unlocked", async () => {
    const pool = new FakePool();
    await marketplace.createMarketplaceListing(pool, { sellerChatId: SELLER, vehicleId: "car-1", askingPrice: 850000 });
    pool.listings.get(LISTING_ID).expires_at = new Date(Date.now() - 1000);
    const result = await marketplace.expireMarketplaceListings(pool);
    assert.equal(result.expiredCount, 1);
    assert.equal(pool.listings.get(LISTING_ID).status, "expired");
    assert.equal("marketplaceListingId" in pool.state.garage[0], false);
  });

  console.log("Player marketplace listing tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
