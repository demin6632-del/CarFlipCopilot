"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { marketplacePurchaseConfirmCallback } = require("./autonomous-game");

const listingId = "123e4567-e89b-42d3-a456-426614174000";
const callback = marketplacePurchaseConfirmCallback(listingId, 1000000000000);

assert.equal(callback, "ag:pmc:" + listingId + ":1000000000000");
assert.ok(Buffer.byteLength(callback, "utf8") <= 64, "Telegram callback_data must not exceed 64 bytes");
assert.throws(() => marketplacePurchaseConfirmCallback("not-a-uuid", 1000));
assert.throws(() => marketplacePurchaseConfirmCallback(listingId, 0));
assert.throws(() => marketplacePurchaseConfirmCallback(listingId, 1000000000001));

const gameSource = fs.readFileSync(require.resolve("./autonomous-game"), "utf8");
const purchaseStart = gameSource.indexOf('purchaseResult = await purchaseMarketplaceListing');
const purchaseCatch = gameSource.indexOf('} catch (error) {', purchaseStart);
const purchaseOutcome = gameSource.indexOf('if (purchaseResult.duplicate)', purchaseCatch);
assert.ok(purchaseStart >= 0 && purchaseCatch > purchaseStart && purchaseOutcome > purchaseCatch,
  "Telegram notifications must be outside the purchase transaction error handler");
const failureReply = gameSource.indexOf('"Покупка не выполнена. Деньги и автомобиль не изменены."', purchaseCatch);
assert.ok(failureReply > purchaseCatch && failureReply < purchaseOutcome,
  "Only transaction errors may produce a failed-purchase message");

console.log("Marketplace purchase UI callback tests: OK");
