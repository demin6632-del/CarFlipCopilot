"use strict";

const crypto = require("node:crypto");

const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_ISSUES_PER_HOUR = 5;
const CODE_BYTES = 8;

function normalizeCode(value) {
  return String(value || "").trim().replace(/[\s-]/g, "").toUpperCase();
}

function hashLinkCode(value) {
  const code = normalizeCode(value);
  if (!/^[A-Z0-9_-]{10,32}$/.test(code)) throw new Error("INVALID_LINK_CODE");
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function createLinkCode() {
  return crypto.randomBytes(CODE_BYTES).toString("hex").toUpperCase();
}

function validTelegramId(value) {
  const id = String(value ?? "");
  if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) throw new Error("INVALID_TELEGRAM_ID");
  return id;
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Issues a one-time code. Only the SHA-256 digest is persisted; the plaintext
 * code is returned once and must never be logged or stored by the caller.
 */
async function issueTelegramLinkChallenge(pool, telegramUserId, options = {}) {
  if (!pool || typeof pool.connect !== "function") throw new Error("DATABASE_POOL_REQUIRED");
  const userId = validTelegramId(telegramUserId);
  const ttlSeconds = Number.isInteger(options.ttlSeconds) && options.ttlSeconds >= 60 && options.ttlSeconds <= 900
    ? options.ttlSeconds : DEFAULT_TTL_SECONDS;
  const maxIssues = Number.isInteger(options.maxIssuesPerHour) && options.maxIssuesPerHour > 0
    ? options.maxIssuesPerHour : MAX_ISSUES_PER_HOUR;
  const code = createLinkCode();
  const digest = hashLinkCode(code);

  const stored = await inTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["autoflip-link:" + userId]);
    const existing = await client.query(
      "SELECT 1 FROM autonomous_telegram_account_links WHERE telegram_user_id=$1",
      [userId]
    );
    if (existing.rowCount) throw new Error("ACCOUNT_ALREADY_LINKED");

    const rate = await client.query(
      "SELECT count(*)::int AS issue_count FROM autonomous_telegram_link_challenges WHERE telegram_user_id=$1 AND created_at > now() - interval '1 hour'",
      [userId]
    );
    if (Number(rate.rows[0]?.issue_count || 0) >= maxIssues) throw new Error("LINK_RATE_LIMITED");

    await client.query(
      "UPDATE autonomous_telegram_link_challenges SET expires_at=now() WHERE telegram_user_id=$1 AND used_at IS NULL AND expires_at > now()",
      [userId]
    );
    const inserted = await client.query(
      "INSERT INTO autonomous_telegram_link_challenges(telegram_user_id, token_hash, expires_at) VALUES($1,$2,now()+($3::int * interval '1 second')) RETURNING expires_at",
      [userId, digest, ttlSeconds]
    );
    return inserted.rows[0];
  });

  return { code, expiresAt: stored.expires_at };
}

/**
 * Redeems a code only from a private bot chat. The challenge, mapping and
 * one-time consumption are committed atomically.
 */
async function confirmTelegramAccountLink(pool, input = {}) {
  if (!pool || typeof pool.connect !== "function") throw new Error("DATABASE_POOL_REQUIRED");
  const telegramUserId = validTelegramId(input.telegramUserId);
  if (input.chatType !== "private") throw new Error("PRIVATE_CHAT_REQUIRED");
  const privateChatId = validTelegramId(input.privateChatId);
  const digest = hashLinkCode(input.code);

  return inTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["autoflip-link:" + telegramUserId]);
    const challengeResult = await client.query(
      "SELECT id, telegram_user_id, (used_at IS NULL AND expires_at > now()) AS usable FROM autonomous_telegram_link_challenges WHERE token_hash=$1 FOR UPDATE",
      [digest]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.telegram_user_id !== telegramUserId || challenge.usable !== true) {
      return { ok: false, reason: "INVALID_OR_EXPIRED_CODE" };
    }

    const inserted = await client.query(
      "INSERT INTO autonomous_telegram_account_links(telegram_user_id, private_chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING telegram_user_id",
      [telegramUserId, privateChatId]
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        "SELECT telegram_user_id, private_chat_id FROM autonomous_telegram_account_links WHERE telegram_user_id=$1 OR private_chat_id=$2",
        [telegramUserId, privateChatId]
      );
      const same = existing.rows.some(row => row.telegram_user_id === telegramUserId && row.private_chat_id === privateChatId);
      return { ok: false, reason: same ? "ACCOUNT_ALREADY_LINKED" : "ACCOUNT_LINK_CONFLICT" };
    }

    await client.query(
      "UPDATE autonomous_telegram_link_challenges SET used_at=now() WHERE id=$1 AND used_at IS NULL",
      [challenge.id]
    );
    return { ok: true };
  });
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_ISSUES_PER_HOUR,
  normalizeCode,
  hashLinkCode,
  createLinkCode,
  issueTelegramLinkChallenge,
  confirmTelegramAccountLink
};
