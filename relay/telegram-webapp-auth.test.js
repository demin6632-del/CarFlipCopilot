"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateTelegramWebAppInitData } = require("./telegram-webapp-auth");

const BOT_TOKEN = "123456:TEST_TOKEN_NOT_REAL";
const NOW = 1_800_000_000;

function makeInitData(overrides = {}) {
  const fields = {
    auth_date: String(NOW - 60),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: 123456789, first_name: "Test", username: "autoflip_test", language_code: "ru" }),
    ...overrides
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  params.append("hash", hash);
  return params.toString();
}

test("accepts a correctly signed, fresh Telegram identity and returns a minimal DTO", () => {
  const result = validateTelegramWebAppInitData(makeInitData(), BOT_TOKEN, { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    id: 123456789,
    firstName: "Test",
    username: "autoflip_test",
    languageCode: "ru"
  });
  assert.equal("hash" in result, false);
});

test("rejects a modified signed field", () => {
  const params = new URLSearchParams(makeInitData());
  params.set("user", JSON.stringify({ id: 999, first_name: "Attacker" }));
  assert.equal(validateTelegramWebAppInitData(params.toString(), BOT_TOKEN, { now: NOW }).reason, "SIGNATURE_INVALID");
});

test("rejects an expired initData payload", () => {
  const raw = makeInitData({ auth_date: String(NOW - 901) });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "INIT_DATA_EXPIRED");
});

test("accepts the exact maximum-age boundary", () => {
  const raw = makeInitData({ auth_date: String(NOW - 900) });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).ok, true);
});

test("rejects a timestamp too far in the future", () => {
  const raw = makeInitData({ auth_date: String(NOW + 31) });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "AUTH_DATE_IN_FUTURE");
});

test("rejects duplicate query fields instead of choosing an ambiguous value", () => {
  const raw = makeInitData() + "&user=" + encodeURIComponent(JSON.stringify({ id: 7 }));
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "DUPLICATE_FIELD");
});

test("rejects malformed and missing input", () => {
  assert.equal(validateTelegramWebAppInitData("", BOT_TOKEN).reason, "MISSING_INIT_DATA");
  assert.equal(validateTelegramWebAppInitData("auth_date=1&user=%7B%7D", BOT_TOKEN).reason, "INVALID_HASH_FORMAT");
  assert.equal(validateTelegramWebAppInitData(makeInitData(), "").reason, "BOT_TOKEN_NOT_CONFIGURED");
});

test("rejects a signed payload with malformed auth_date", () => {
  const raw = makeInitData({ auth_date: "not-a-timestamp" });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "AUTH_DATE_INVALID");
});

test("rejects a signed payload with malformed user JSON", () => {
  const raw = makeInitData({ user: "{not-json" });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "USER_JSON_INVALID");
});

test("rejects a signed payload without a valid positive safe-integer Telegram user ID", () => {
  const raw = makeInitData({ user: JSON.stringify({ id: "123" }) });
  assert.equal(validateTelegramWebAppInitData(raw, BOT_TOKEN, { now: NOW }).reason, "USER_ID_INVALID");
});

test("enforces the maximum payload length", () => {
  assert.equal(validateTelegramWebAppInitData("x".repeat(20), BOT_TOKEN, { maxLength: 10 }).reason, "INIT_DATA_TOO_LARGE");
});
