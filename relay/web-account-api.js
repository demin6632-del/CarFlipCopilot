"use strict";

const crypto = require("node:crypto");
const { validateTelegramWebAppInitData } = require("./telegram-webapp-auth");
const { readLinkedTelegramProfile } = require("./telegram-account-profile");
const { issueTelegramLinkChallenge } = require("./telegram-account-linking");
const { listActiveMarketplaceListings, listMarketplaceListingsForSeller } = require("./player-marketplace-listings");

const COOKIE_NAME = "__Host-autoflip_session";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 20 * 1024;

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sessionHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookie(header, name) {
  if (typeof header !== "string" || header.length > 8192) return null;
  const matches = header.split(";").map(part => part.trim())
    .filter(part => part.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : null;
}

async function readJsonBody(req) {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("BODY_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    body += chunk;
  }
  try {
    const value = JSON.parse(body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error("INVALID_JSON");
    error.statusCode = 400;
    throw error;
  }
}

function createWebAccountApi(options = {}) {
  const pool = options.pool;
  const botToken = options.botToken;
  const webOrigin = options.webOrigin;
  const ttlSeconds = Number.isInteger(options.sessionTtlSeconds) && options.sessionTtlSeconds > 0
    ? Math.min(options.sessionTtlSeconds, 30 * 24 * 60 * 60)
    : DEFAULT_SESSION_TTL_SECONDS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  if (!pool || typeof pool.query !== "function") throw new Error("DATABASE_POOL_REQUIRED");
  if (typeof botToken !== "string" || !botToken) throw new Error("BOT_TOKEN_REQUIRED");
  let expectedOrigin;
  try {
    expectedOrigin = new URL(webOrigin).origin;
    if (expectedOrigin === "null") throw new Error();
  } catch {
    throw new Error("WEB_ORIGIN_INVALID");
  }

  return async function handleWebAccountRequest(req, res) {
    const path = String(req.url || "").split("?")[0];
    if (!["/api/web/session", "/api/web/profile", "/api/web/logout", "/api/web/link-challenge", "/api/web/marketplace", "/api/web/marketplace/mine"].includes(path)) return false;

    try {
      if (path !== "/api/web/profile") {
        if (req.headers?.origin !== expectedOrigin) {
          send(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
          return true;
        }
      }

      if (path === "/api/web/link-challenge") {
        if (req.method !== "POST") {
          send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
          return true;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.["content-type"] || ""))) {
          send(res, 415, { error: "JSON_REQUIRED" });
          return true;
        }
        const body = await readJsonBody(req);
        const auth = validateTelegramWebAppInitData(body.initData, botToken, { now: Math.floor(now() / 1000) });
        if (!auth.ok) {
          send(res, 401, { error: "TELEGRAM_AUTH_INVALID" });
          return true;
        }
        try {
          const challenge = await issueTelegramLinkChallenge(pool, String(auth.user.id));
          send(res, 200, {
            ok: true,
            code: challenge.code,
            expiresAt: Math.floor(new Date(challenge.expiresAt).getTime() / 1000)
          });
        } catch (error) {
          if (error?.message === "ACCOUNT_ALREADY_LINKED") {
            send(res, 409, { error: "ACCOUNT_ALREADY_LINKED" });
            return true;
          }
          if (error?.message === "LINK_RATE_LIMITED") {
            send(res, 429, { error: "LINK_RATE_LIMITED" }, { "retry-after": "3600" });
            return true;
          }
          throw error;
        }
        return true;
      }

      if (path === "/api/web/session") {
        if (req.method !== "POST") {
          send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
          return true;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.["content-type"] || ""))) {
          send(res, 415, { error: "JSON_REQUIRED" });
          return true;
        }
        const body = await readJsonBody(req);
        const auth = validateTelegramWebAppInitData(body.initData, botToken, { now: Math.floor(now() / 1000) });
        if (!auth.ok) {
          send(res, 401, { error: "TELEGRAM_AUTH_INVALID" });
          return true;
        }

        const telegramUserId = String(auth.user.id);
        const rate = await pool.query(
          `INSERT INTO autonomous_web_session_rate_limits AS current_limit
             (telegram_user_id, window_started_at, attempts)
           SELECT l.telegram_user_id, now(), 1
             FROM autonomous_telegram_account_links AS l
            WHERE l.telegram_user_id = $1
           ON CONFLICT (telegram_user_id) DO UPDATE
             SET attempts = CASE
                   WHEN current_limit.window_started_at <= now() - interval '1 hour' THEN 1
                   ELSE current_limit.attempts + 1
                 END,
                 window_started_at = CASE
                   WHEN current_limit.window_started_at <= now() - interval '1 hour' THEN now()
                   ELSE current_limit.window_started_at
                 END
           RETURNING attempts, window_started_at`,
          [telegramUserId]
        );
        if (!rate?.rowCount) {
          send(res, 403, { error: "TELEGRAM_ACCOUNT_NOT_LINKED" });
          return true;
        }
        if (Number(rate.rows[0].attempts) > 10) {
          const windowStart = new Date(rate.rows[0].window_started_at).getTime();
          const retryAfter = Number.isFinite(windowStart)
            ? Math.max(1, Math.ceil((windowStart + 60 * 60 * 1000 - now()) / 1000))
            : 3600;
          send(res, 429, { error: "SESSION_RATE_LIMITED" }, { "retry-after": String(retryAfter) });
          return true;
        }

        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
        const result = await pool.query(
          `INSERT INTO autonomous_web_sessions(session_hash, telegram_user_id, expires_at)
           SELECT $1, l.telegram_user_id, to_timestamp($2)
             FROM autonomous_telegram_account_links AS l
            WHERE l.telegram_user_id = $3
           RETURNING telegram_user_id`,
          [sessionHash(token), expiresAt, telegramUserId]
        );
        if (!result?.rowCount) {
          send(res, 403, { error: "TELEGRAM_ACCOUNT_NOT_LINKED" });
          return true;
        }

        send(res, 200, { ok: true, expiresAt }, {
          "set-cookie": COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + ttlSeconds
        });
        return true;
      }

      const token = readCookie(req.headers?.cookie, COOKIE_NAME);
      if (!token) {
        send(res, 401, { error: "SESSION_REQUIRED" });
        return true;
      }
      const digest = sessionHash(token);

      if (path === "/api/web/logout") {
        if (req.method !== "POST") {
          send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
          return true;
        }
        await pool.query("DELETE FROM autonomous_web_sessions WHERE session_hash = $1", [digest]);
        send(res, 200, { ok: true }, {
          "set-cookie": COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        });
        return true;
      }

      if (req.method !== "GET") {
        send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET" });
        return true;
      }
      const session = await pool.query(
        `SELECT telegram_user_id
           FROM autonomous_web_sessions
          WHERE session_hash = $1 AND expires_at > now()
          LIMIT 1`,
        [digest]
      );
      if (!session?.rowCount) {
        send(res, 401, { error: "SESSION_EXPIRED" });
        return true;
      }
      if (path === "/api/web/marketplace" || path === "/api/web/marketplace/mine") {
        const url = new URL(req.url || "/", expectedOrigin);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 10;
        const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50 ||
            !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
          send(res, 400, { error: "INVALID_PAGINATION" });
          return true;
        }
        let listings;
        if (path === "/api/web/marketplace") {
          listings = await listActiveMarketplaceListings(pool, { limit, offset, search: url.searchParams.get("search") || "" });
        } else {
          const linked = await pool.query("SELECT private_chat_id FROM autonomous_telegram_account_links WHERE telegram_user_id=$1 LIMIT 1", [String(session.rows[0].telegram_user_id)]);
          if (!linked || !linked.rowCount) { send(res, 401, { error: "ACCOUNT_LINK_REQUIRED" }); return true; }
          listings = await listMarketplaceListingsForSeller(pool, String(linked.rows[0].private_chat_id), { limit, offset });
        }
        send(res, 200, { ok: true, listings });
        return true;
      }
      const profile = await readLinkedTelegramProfile(pool, session.rows[0].telegram_user_id);
      if (!profile) {
        send(res, 401, { error: "ACCOUNT_LINK_REQUIRED" });
        return true;
      }
      send(res, 200, { ok: true, profile });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : (error.code === "42P01" ? 503 : 500);
      const code = error.code === "42P01" ? "MARKETPLACE_NOT_READY" : (status === 500 ? "INTERNAL_ERROR" : error.message);
      send(res, status, { error: code });
      if (status === 500 && typeof options.onError === "function") options.onError(error);
      return true;
    }
  };
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_SESSION_TTL_SECONDS,
  createWebAccountApi,
  sessionHash,
  readCookie
};
