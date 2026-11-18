"use strict";

const crypto = require("node:crypto");

const DEFAULT_MAX_AGE_SECONDS = 15 * 60;
const DEFAULT_FUTURE_TOLERANCE_SECONDS = 30;
const MAX_INIT_DATA_LENGTH = 16 * 1024;

function failure(reason) {
  return { ok: false, reason };
}

/**
 * Validate raw Telegram Mini App initData using Telegram's bot-token HMAC scheme.
 * This function does not perform account/chat mapping, create sessions, or access a DB.
 */
function validateTelegramWebAppInitData(rawInitData, botToken, options = {}) {
  if (typeof rawInitData !== "string" || rawInitData.length === 0) {
    return failure("MISSING_INIT_DATA");
  }
  if (rawInitData.length > (options.maxLength || MAX_INIT_DATA_LENGTH)) {
    return failure("INIT_DATA_TOO_LARGE");
  }
  if (typeof botToken !== "string" || botToken.length === 0) {
    return failure("BOT_TOKEN_NOT_CONFIGURED");
  }

  const params = new URLSearchParams(rawInitData);
  const values = new Map();
  for (const [key, value] of params.entries()) {
    if (values.has(key)) return failure("DUPLICATE_FIELD");
    values.set(key, value);
  }

  const receivedHash = values.get("hash");
  if (typeof receivedHash !== "string" || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return failure("INVALID_HASH_FORMAT");
  }
  if (!values.has("auth_date") || !values.has("user")) {
    return failure("REQUIRED_FIELD_MISSING");
  }

  const dataCheckString = [...values.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(receivedHash, "hex");
  if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
    return failure("SIGNATURE_INVALID");
  }

  const authDateText = values.get("auth_date");
  if (!/^\d{1,12}$/.test(authDateText)) return failure("AUTH_DATE_INVALID");
  const authDate = Number(authDateText);
  const now = Number.isFinite(options.now) ? Math.floor(options.now) : Math.floor(Date.now() / 1000);
  const maxAgeSeconds = Number.isInteger(options.maxAgeSeconds) && options.maxAgeSeconds >= 0
    ? options.maxAgeSeconds : DEFAULT_MAX_AGE_SECONDS;
  const futureToleranceSeconds = Number.isInteger(options.futureToleranceSeconds) && options.futureToleranceSeconds >= 0
    ? options.futureToleranceSeconds : DEFAULT_FUTURE_TOLERANCE_SECONDS;

  if (authDate > now + futureToleranceSeconds) return failure("AUTH_DATE_IN_FUTURE");
  if (now - authDate > maxAgeSeconds) return failure("INIT_DATA_EXPIRED");

  let user;
  try {
    user = JSON.parse(values.get("user"));
  } catch {
    return failure("USER_JSON_INVALID");
  }
  if (!user || typeof user !== "object" || Array.isArray(user)
      || !Number.isSafeInteger(user.id) || user.id <= 0) {
    return failure("USER_ID_INVALID");
  }

  return {
    ok: true,
    authDate,
    user: {
      id: user.id,
      firstName: typeof user.first_name === "string" ? user.first_name : "",
      username: typeof user.username === "string" ? user.username : null,
      languageCode: typeof user.language_code === "string" ? user.language_code : null
    }
  };
}

module.exports = {
  validateTelegramWebAppInitData,
  DEFAULT_MAX_AGE_SECONDS,
  DEFAULT_FUTURE_TOLERANCE_SECONDS,
  MAX_INIT_DATA_LENGTH
};
