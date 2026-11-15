"use strict";

const assert = require("node:assert/strict");
const { marketplacePurchaseConfirmCallback } = require("./autonomous-game");

const listingId = "123e4567-e89b-42d3-a456-426614174000";
const callback = marketplacePurchaseConfirmCallback(listingId, 1000000000000);

assert.equal(callback, "ag:pmc:" + listingId + ":1000000000000");
assert.ok(Buffer.byteLength(callback, "utf8") <= 64, "Telegram callback_data must not exceed 64 bytes");
assert.throws(() => marketplacePurchaseConfirmCallback("not-a-uuid", 1000));
assert.throws(() => marketplacePurchaseConfirmCallback(listingId, 0));
assert.throws(() => marketplacePurchaseConfirmCallback(listingId, 1000000000001));

console.log("Marketplace purchase UI callback tests: OK");
