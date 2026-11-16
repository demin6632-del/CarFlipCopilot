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
const listingSource = fs.readFileSync(require.resolve("./player-marketplace-listings"), "utf8");
const telegramSource = fs.readFileSync(require.resolve("./telegram-bot"), "utf8");
assert.match(telegramSource, /autonomousGame\.handleCallback\(chat,data,q\.from\?\.first_name\|\|"Перекуп",\s*\(c,t,extra\)=>send\(c,t,extra\),\s*\(\)=>Promise\.resolve\(\),\s*q\.id\)/,
  "Telegram callback query ID must reach the game callback handler for idempotent settlement");
assert.match(gameSource, /purchaseMarketplaceListing\(await p,\s*\{\s*buyerChatId:\s*String\(chat\),\s*listingId:\s*id,\s*expectedPrice,\s*callbackId:\s*String\(callbackId \|\| ""\)/,
  "Purchase settlement must receive the confirmed price and Telegram callback ID");
const purchaseStart = gameSource.indexOf('purchaseResult = await purchaseMarketplaceListing');
const purchaseCatch = gameSource.indexOf('} catch (error) {', purchaseStart);
const purchaseOutcome = gameSource.indexOf('if (purchaseResult.duplicate)', purchaseCatch);
assert.ok(purchaseStart >= 0 && purchaseCatch > purchaseStart && purchaseOutcome > purchaseCatch,
  "Telegram notifications must be outside the purchase transaction error handler");
const failureReply = gameSource.indexOf('"Покупка не выполнена. Деньги и автомобиль не изменены."', purchaseCatch);
assert.ok(failureReply > purchaseCatch && failureReply < purchaseOutcome,
  "Only transaction errors may produce a failed-purchase message");
const sellerNotice = gameSource.indexOf("MARKETPLACE SELLER NOTIFICATION WARNING:", purchaseCatch);
assert.ok(sellerNotice > purchaseCatch && sellerNotice < purchaseOutcome,
  "Seller notification must happen after settlement and before the buyer outcome");
assert.match(gameSource.slice(purchaseCatch, purchaseOutcome), /COMMIT_OUTCOME_UNKNOWN:[^\n]*Покупка могла завершиться/,
  "Ambiguous commit outcomes must never claim that the purchase definitely failed");
assert.match(gameSource.slice(purchaseCatch, purchaseOutcome), /if \(purchaseResult\.ok && purchaseResult\.sellerChatId\)[\s\S]*?try \{[\s\S]*?sendFn\(purchaseResult\.sellerChatId[\s\S]*?catch \(notifyError\)/,
  "Seller notification delivery errors must be isolated from the committed purchase result");
assert.doesNotMatch(gameSource, /УКАЖИ ЦЕНУ\\\\n/, "Marketplace listing price prompt must contain real line breaks");
assert.doesNotMatch(gameSource, /ОБЪЯВЛЕНИЕ СНЯТО\\\\n/, "Marketplace cancellation confirmation must contain real line breaks");
assert.doesNotMatch(gameSource, /АВТОМОБИЛЬ ВЫСТАВЛЕН НА ОБЩИЙ РЫНОК\\\\n/, "Marketplace listing success message must contain real line breaks");
const listingCreateStart = gameSource.indexOf("listingResult = await createMarketplaceListing");
const listingCreateCatch = gameSource.indexOf("} catch (error) {", listingCreateStart);
const listingCreateOutcome = gameSource.indexOf("PLAYER MARKETPLACE SUCCESS NOTIFICATION WARNING:", listingCreateCatch);
assert.ok(listingCreateStart >= 0 && listingCreateCatch > listingCreateStart && listingCreateOutcome > listingCreateCatch,
  "Marketplace listing success notification must be outside the listing transaction error handler");
assert.match(gameSource.slice(listingCreateOutcome - 1200, listingCreateOutcome), /PLAYER MARKETPLACE PENDING CLEANUP WARNING/,
  "Pending-listing cleanup errors must be isolated after a committed listing");

assert.match(listingSource, /state\.pendingDeal && String\(state\.pendingDeal\.carId\) === vehicleId/,
  "Listing creation transaction must reject a vehicle with an active ordinary-sale negotiation");
assert.match(gameSource, /const pendingDealCarId = state\.pendingDeal\?\.carId/,
  "Marketplace vehicle picker must hide a vehicle with an active ordinary-sale negotiation");
assert.match(gameSource, /reason: "pending_deal"/,
  "Stale marketplace selection callbacks must reject a vehicle with an active negotiation");
assert.match(gameSource, /PENDING_DEAL_ACTIVE/,
  "Listing text flow must explain that an active negotiation must be completed or cancelled");

const rollbackStart = gameSource.indexOf('if(action==="rollback"){');
const rollbackEnd = gameSource.indexOf('if(action==="garage")', rollbackStart);
const rollbackBlock = gameSource.slice(rollbackStart, rollbackEnd);
assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart, "Mileage rollback handler must remain present");
assert.ok(
  rollbackBlock.indexOf("if(car.marketplaceListingId)") >= 0 &&
  rollbackBlock.indexOf("if(car.marketplaceListingId)") < rollbackBlock.indexOf("car.mileageRolledBack"),
  "Listed vehicles must be blocked before mileage rollback can mutate the odometer"
);

console.log("Marketplace purchase UI callback tests: OK");
