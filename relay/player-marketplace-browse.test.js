"use strict";

const assert = require("node:assert/strict");
const {
  listActiveMarketplaceListings,
  getActiveMarketplaceListing,
  listMarketplaceListingsForSeller
} = require("./player-marketplace-listings");

const sample = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  seller_chat_id: "seller-7",
  asking_price: "850000",
  status: "active",
  vehicle_snapshot: {
    model: "Lada Vesta 1.6",
    catalogId: "vesta_2019",
    year: 2019,
    plate: "А123ВС 77",
    mileage: 65000,
    condition: 92,
    damage: 1,
    marketplaceListingId: "must-not-leak"
  },
  created_at: new Date("2026-11-15T10:00:00Z"),
  expires_at: new Date("2026-11-22T10:00:00Z")
};

(async () => {
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [sample] };
    }
  };

  const rows = await listActiveMarketplaceListings(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].askingPrice, 850000);
  assert.equal("sellerChatId" in rows[0], false, "public browse must not expose Telegram account IDs");
  assert.equal(rows[0].vehicle.model, "Lada Vesta 1.6");
  assert.equal("marketplaceListingId" in rows[0].vehicle, false);
  assert.match(captured.sql, /status='active' AND expires_at>now\(\)/);
  assert.match(captured.sql, /ORDER BY created_at DESC,id DESC LIMIT \$1 OFFSET \$2/);
  assert.deepEqual(captured.params, [10, 0]);

  await listActiveMarketplaceListings(pool, { search: "Vesta", limit: 5, offset: 10 });
  assert.match(captured.sql, /vehicle_snapshot->>'model' ILIKE \$1/);
  assert.deepEqual(captured.params, ["%Vesta%", 5, 10]);

  const detailPool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 1, rows: [sample] };
    }
  };
  const detail = await getActiveMarketplaceListing(detailPool, sample.id);
  assert.equal(detail.id, sample.id);
  assert.equal(detail.vehicle.catalogId, "vesta_2019");
  assert.match(captured.sql, /id=\\$1::uuid AND status='active' AND expires_at>now\\(\\)/);
  assert.deepEqual(captured.params, [sample.id]);
  await assert.rejects(
    () => getActiveMarketplaceListing(detailPool, "not-a-uuid"),
    error => error.code === "INVALID_LISTING_ID"
  );
  const unavailablePool = { async query() { return { rowCount: 0, rows: [] }; } };
  assert.equal(await getActiveMarketplaceListing(unavailablePool, sample.id), null);

  await listMarketplaceListingsForSeller(pool, "seller-7", { limit: 20, offset: 40 });
  assert.match(captured.sql, /WHERE seller_chat_id=\$1/);
  assert.deepEqual(captured.params, ["seller-7", 20, 40]);

  await assert.rejects(
    () => listActiveMarketplaceListings(pool, { limit: 51 }),
    error => error.code === "INVALID_LIMIT"
  );
  await assert.rejects(
    () => listActiveMarketplaceListings(pool, { offset: -1 }),
    error => error.code === "INVALID_OFFSET"
  );
  await assert.rejects(
    () => listMarketplaceListingsForSeller(pool, ""),
    error => error.code === "INVALID_SELLER"
  );

  console.log("Player marketplace browse tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
