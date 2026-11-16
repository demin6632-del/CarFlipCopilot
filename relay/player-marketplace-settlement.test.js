"use strict";

const assert = require("node:assert/strict");
const { purchaseMarketplaceListing } = require("./player-marketplace-settlement");

const BUYER = "20002";
const SELLER = "10001";
const UID = "11111111-1111-5111-8111-111111111111";
const LISTING = "22222222-2222-5222-8222-222222222222";
const CALLBACK = "tg-callback-1";

function state(chatId, balance, garage = []) {
  return {
    player: { name: chatId, balance, garageCapacity: 3 },
    garage,
    transactions: [],
    meta: {}
  };
}

class FakePool {
  constructor() {
    this.states = new Map([
      [BUYER, state(BUYER, 2000000)],
      [SELLER, state(SELLER, 500000, [{
        id: "seller-car-1", vehicleUid: UID, plate: "А123ВС 77",
        model: "Lada Vesta 1.6", mileage: 65000, condition: 92,
        marketplaceListingId: LISTING
      }])]
    ]);
    this.listing = {
      id: LISTING, vehicle_uid: UID, seller_chat_id: SELLER,
      asking_price: 850000, status: "active",
      expires_at: new Date(Date.now() + 3600000)
    };
    this.registry = { owner_chat_id: SELLER, plate: "А123ВС 77", retired_at: null };
    this.receipts = new Set();
    this.ledger = [];
    this.marketTransactions = [];
    this.commits = 0;
    this.rollbacks = 0;
    this.lastStateLockOrder = [];
  }

  async connect() {
    const pool = this;
    return {
      snapshot: null,
      async query(sql, params = []) {
        if (sql === "BEGIN") {
          this.snapshot = {
            states: new Map([...pool.states].map(([k,v]) => [k, structuredClone(v)])),
            listing: structuredClone(pool.listing),
            registry: structuredClone(pool.registry),
            receipts: new Set(pool.receipts),
            ledger: structuredClone(pool.ledger),
            marketTransactions: structuredClone(pool.marketTransactions)
          };
          return { rowCount: 0, rows: [] };
        }
        if (sql === "COMMIT") {
          this.snapshot = null;
          pool.commits++;
          return { rowCount: 0, rows: [] };
        }
        if (sql === "ROLLBACK") {
          if (this.snapshot) {
            pool.states = this.snapshot.states;
            pool.listing = this.snapshot.listing;
            pool.registry = this.snapshot.registry;
            pool.receipts = this.snapshot.receipts;
            pool.ledger = this.snapshot.ledger;
            pool.marketTransactions = this.snapshot.marketTransactions;
            this.snapshot = null;
          }
          pool.rollbacks++;
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("SELECT seller_chat_id FROM autonomous_marketplace_listings")) {
          return { rowCount: 1, rows: [{ seller_chat_id: pool.listing.seller_chat_id }] };
        }
        if (sql.includes("SELECT chat_id,state FROM autonomous_game_state")) {
          pool.lastStateLockOrder = [...params[0]];
          return {
            rowCount: pool.states.size,
            rows: [...pool.states].map(([chat_id, value]) => ({ chat_id, state: structuredClone(value) }))
          };
        }
        if (sql.includes("FROM autonomous_marketplace_listings WHERE id=$1::uuid FOR UPDATE")) {
          return { rowCount: 1, rows: [structuredClone(pool.listing)] };
        }
        if (sql.includes("INSERT INTO autonomous_processed_callbacks")) {
          const key = params[0] + ":" + params[1];
          if (pool.receipts.has(key)) return { rowCount: 0, rows: [] };
          pool.receipts.add(key);
          return { rowCount: 1, rows: [{ callback_id: params[1] }] };
        }
        if (sql.includes("UPDATE vehicle_plate_registry SET owner_chat_id=$3")) {
          if (pool.registry.owner_chat_id !== params[1] || pool.registry.retired_at) return { rowCount: 0, rows: [] };
          pool.registry.owner_chat_id = params[2];
          return { rowCount: 1, rows: [{ plate: pool.registry.plate }] };
        }
        if (sql.includes("INSERT INTO autonomous_economy_ledger")) {
          pool.ledger.push({ buyer: params[1], buyerAmount: params[2], seller: params[7], sellerAmount: params[8] });
          return { rowCount: 2, rows: [] };
        }
        if (sql.includes("UPDATE autonomous_game_state SET state=")) {
          pool.states.set(params[0], JSON.parse(params[1]));
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("UPDATE autonomous_marketplace_listings SET status='sold'")) {
          pool.listing.status = "sold";
          pool.listing.sold_to_chat_id = params[1];
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("INSERT INTO autonomous_marketplace_transactions")) {
          pool.marketTransactions.push(params);
          return { rowCount: 1, rows: [] };
        }
        throw new Error("Unexpected SQL: " + sql);
      },
      release() {}
    };
  }
}

class CommitAckLostPool extends FakePool {
  async connect() {
    const client = await super.connect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const result = await originalQuery(sql, params);
      if (sql === "COMMIT") throw new Error("simulated lost COMMIT acknowledgement");
      return result;
    };
    return client;
  }

  async query(sql, params) {
    if (!sql.includes("FROM autonomous_processed_callbacks c")) {
      throw new Error("Unexpected recovery SQL: " + sql);
    }
    const receiptKey = params[0] + ":" + params[2];
    if (!this.receipts.has(receiptKey) || this.listing.status !== "sold" ||
        this.listing.sold_to_chat_id !== params[0]) {
      return { rowCount: 0, rows: [] };
    }
    return {
      rowCount: 1,
      rows: [{
        vehicle_uid: UID,
        gross_amount: this.listing.asking_price,
        seller_chat_id: SELLER,
        status: "sold",
        sold_to_chat_id: BUYER,
        plate: this.registry.plate,
        state: structuredClone(this.states.get(BUYER))
      }]
    };
  }
}

async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
}

(async () => {
  await test("purchase atomically transfers car, plate ownership and both balances", async () => {
    const pool = new FakePool();
    const result = await purchaseMarketplaceListing(pool, {
      buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK
    });
    assert.equal(result.ok, true);
    assert.equal(result.price, 850000);
    assert.equal(result.sellerChatId, SELLER, "private settlement result identifies the seller for post-commit notification");
    assert.equal(pool.states.get(BUYER).player.balance, 1150000);
    assert.equal(pool.states.get(SELLER).player.balance, 1350000);
    assert.equal(pool.states.get(BUYER).garage[0].vehicleUid, UID);
    assert.equal(pool.states.get(BUYER).garage[0].plate, "А123ВС 77");
    assert.equal("marketplaceListingId" in pool.states.get(BUYER).garage[0], false);
    assert.equal(pool.states.get(SELLER).garage.length, 0);
    assert.equal(pool.registry.owner_chat_id, BUYER);
    assert.equal(pool.listing.status, "sold");
    assert.equal(pool.ledger.length, 1);
    assert.equal(pool.marketTransactions.length, 1);
    assert.deepEqual(pool.lastStateLockOrder, [BUYER, SELLER].sort());
    assert.equal(pool.commits, 1);
  });

  await test("stale confirmation price aborts without debiting or transferring the vehicle", async () => {
    const pool = new FakePool();
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, {
        buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK, expectedPrice: 840000
      }),
      error => error.code === "PRICE_CHANGED"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 2000000);
    assert.equal(pool.states.get(SELLER).player.balance, 500000);
    assert.equal(pool.registry.owner_chat_id, SELLER);
    assert.equal(pool.listing.status, "active");
    assert.equal(pool.ledger.length, 0);
    assert.equal(pool.marketTransactions.length, 0);
    assert.equal(pool.receipts.size, 0);
    assert.equal(pool.commits, 0);
  });

  await test("lost COMMIT acknowledgement is recovered from the durable receipt without a second settlement", async () => {
    const pool = new CommitAckLostPool();
    const result = await purchaseMarketplaceListing(pool, {
      buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK
    });
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.price, 850000);
    assert.equal(result.sellerChatId, SELLER);
    assert.equal(pool.states.get(BUYER).player.balance, 1150000);
    assert.equal(pool.states.get(SELLER).player.balance, 1350000);
    assert.equal(pool.registry.owner_chat_id, BUYER);
    assert.equal(pool.listing.status, "sold");
    assert.equal(pool.ledger.length, 1);
    assert.equal(pool.marketTransactions.length, 1);
    assert.equal(pool.receipts.size, 1);
    assert.equal(pool.commits, 1);
  });

  await test("same callback replay is rejected without a second debit", async () => {
    const pool = new FakePool();
    await purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK });
    const replay = await purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK });
    assert.equal(replay.duplicate, true);
    assert.equal(pool.states.get(BUYER).player.balance, 1150000);
    assert.equal(pool.ledger.length, 1);
    assert.equal(pool.commits, 1);
  });

  await test("insufficient funds rolls back without changing either account or registry", async () => {
    const pool = new FakePool();
    pool.states.get(BUYER).player.balance = 100;
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.code === "INSUFFICIENT_FUNDS"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 100);
    assert.equal(pool.states.get(SELLER).player.balance, 500000);
    assert.equal(pool.registry.owner_chat_id, SELLER);
    assert.equal(pool.listing.status, "active");
    assert.equal(pool.ledger.length, 0);
  });

  await test("self-purchase is rejected before changing any state", async () => {
    const pool = new FakePool();
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: SELLER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.code === "SELF_PURCHASE"
    );
    assert.equal(pool.listing.status, "active");
    assert.equal(pool.commits, 0);
  });

  await test("registry ownership mismatch aborts the complete settlement", async () => {
    const pool = new FakePool();
    pool.registry.owner_chat_id = "30003";
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.message === "Vehicle transfer rejected: source owner does not match"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 2000000);
    assert.equal(pool.states.get(SELLER).player.balance, 500000);
    assert.equal(pool.listing.status, "active");
    assert.equal(pool.ledger.length, 0);
  });

  await test("full buyer garage blocks purchase without charging either player", async () => {
    const pool = new FakePool();
    pool.states.get(BUYER).garage = [{ id: "a" }, { id: "b" }, { id: "c" }];
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.code === "GARAGE_FULL"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 2000000);
    assert.equal(pool.states.get(SELLER).player.balance, 500000);
    assert.equal(pool.registry.owner_chat_id, SELLER);
    assert.equal(pool.listing.status, "active");
  });

  await test("seller balance overflow rejects before transferring the vehicle", async () => {
    const pool = new FakePool();
    pool.states.get(SELLER).player.balance = Number.MAX_SAFE_INTEGER - 100;
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.code === "BALANCE_OVERFLOW"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 2000000);
    assert.equal(pool.states.get(SELLER).player.balance, Number.MAX_SAFE_INTEGER - 100);
    assert.equal(pool.registry.owner_chat_id, SELLER);
    assert.equal(pool.listing.status, "active");
    assert.equal(pool.ledger.length, 0);
    assert.equal(pool.marketTransactions.length, 0);
    assert.equal(pool.receipts.size, 0);
  });

  await test("expired listing cannot be purchased", async () => {
    const pool = new FakePool();
    pool.listing.expires_at = new Date(Date.now() - 1000);
    await assert.rejects(
      () => purchaseMarketplaceListing(pool, { buyerChatId: BUYER, listingId: LISTING, callbackId: CALLBACK }),
      error => error.code === "LISTING_NOT_ACTIVE"
    );
    assert.equal(pool.states.get(BUYER).player.balance, 2000000);
    assert.equal(pool.registry.owner_chat_id, SELLER);
  });

  console.log("Player marketplace settlement tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
