"use strict";

const crypto = require("node:crypto");
const { validateTelegramWebAppInitData } = require("./telegram-webapp-auth");
const { readLinkedTelegramProfile } = require("./telegram-account-profile");

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
    if (!["/api/web/session", "/api/web/profile", "/api/web/logout"].includes(path)) return false;

    try {
      if (path !== "/api/web/profile") {
        if (req.headers?.origin !== expectedOrigin) {
          send(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
          return true;
        }
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

        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
        const result = await pool.query(
          `INSERT INTO autonomous_web_sessions(session_hash, telegram_user_id, expires_at)
           SELECT $1, l.telegram_user_id, to_timestamp($2)
             FROM autonomous_telegram_account_links AS l
            WHERE l.telegram_user_id = $3
           RETURNING telegram_user_id`,
          [sessionHash(token), expiresAt, String(auth.user.id)]
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
      const profile = await readLinkedTelegramProfile(pool, session.rows[0].telegram_user_id);
      if (!profile) {
        send(res, 401, { error: "ACCOUNT_LINK_REQUIRED" });
        return true;
      }
      send(res, 200, { ok: true, profile });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      send(res, status, { error: status === 500 ? "INTERNAL_ERROR" : error.message });
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
