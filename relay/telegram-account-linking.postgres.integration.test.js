"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const {
  issueTelegramLinkChallenge,
  confirmTelegramAccountLink,
  hashLinkCode
} = require("./telegram-account-linking");

const connectionString = process.env.TEST_DATABASE_URL || "";
test("Telegram account-link challenges are safe under PostgreSQL concurrency and rollback", {
  skip: !connectionString
}, async () => {
  const schema = "autoflip_link_" + randomUUID().replace(/-/g, "");
  const adminPool = new Pool({ connectionString, max: 1 });
  let appPool;
  try {
    await adminPool.query("CREATE SCHEMA " + schema);
    appPool = new Pool({
      connectionString,
      max: 5,
      options: "-c search_path=" + schema + ",public"
    });
    const migration = fs.readFileSync(path.join(__dirname, "telegram-account-linking.sql"), "utf8");
    await appPool.query(migration);
    await appPool.query(migration);

    // A newly issued code invalidates the previous active code; only its digest is stored.
    const first = await issueTelegramLinkChallenge(appPool, "10001");
    const second = await issueTelegramLinkChallenge(appPool, "10001");
    const stored = await appPool.query(
      "SELECT token_hash, expires_at FROM autonomous_telegram_link_challenges WHERE telegram_user_id=$1 ORDER BY created_at DESC, id DESC",
      ["10001"]
    );
    assert.equal(stored.rows.length, 2);
    assert.equal(stored.rows.some(row => row.token_hash === first.code), false);
    assert.equal(stored.rows.some(row => row.token_hash === second.code), false);
    assert.equal(stored.rows.some(row => row.token_hash === hashLinkCode(second.code)), true);

    const oldCode = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10001", privateChatId: "10001", chatType: "private", code: first.code
    });
    assert.deepEqual(oldCode, { ok: false, reason: "INVALID_OR_EXPIRED_CODE" });

    const linked = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10001", privateChatId: "10001", chatType: "private", code: second.code
    });
    assert.deepEqual(linked, { ok: true });
    const replay = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10001", privateChatId: "10001", chatType: "private", code: second.code
    });
    assert.deepEqual(replay, { ok: false, reason: "INVALID_OR_EXPIRED_CODE" });

    // Expiry is checked by PostgreSQL time, not the application host clock.
    const expired = await issueTelegramLinkChallenge(appPool, "10002");
    await appPool.query(
      "UPDATE autonomous_telegram_link_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hashLinkCode(expired.code)]
    );
    const expiredResult = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10002", privateChatId: "10002", chatType: "private", code: expired.code
    });
    assert.deepEqual(expiredResult, { ok: false, reason: "INVALID_OR_EXPIRED_CODE" });

    // A code issued to one Telegram identity cannot be redeemed by another.
    const owned = await issueTelegramLinkChallenge(appPool, "10003");
    const wrongOwner = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10004", privateChatId: "10004", chatType: "private", code: owned.code
    });
    assert.deepEqual(wrongOwner, { ok: false, reason: "INVALID_OR_EXPIRED_CODE" });

    // Two simultaneous redemptions of the same code must produce exactly one link.
    const concurrent = await issueTelegramLinkChallenge(appPool, "10005");
    const results = await Promise.all([
      confirmTelegramAccountLink(appPool, {
        telegramUserId: "10005", privateChatId: "10005", chatType: "private", code: concurrent.code
      }),
      confirmTelegramAccountLink(appPool, {
        telegramUserId: "10005", privateChatId: "10005", chatType: "private", code: concurrent.code
      })
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.reason === "INVALID_OR_EXPIRED_CODE").length, 1);
    const concurrentLinks = await appPool.query(
      "SELECT count(*)::int AS count FROM autonomous_telegram_account_links WHERE telegram_user_id=$1",
      ["10005"]
    );
    assert.equal(concurrentLinks.rows[0].count, 1);

    // The unique private-chat constraint prevents a second identity claiming the same chat.
    const collision = await issueTelegramLinkChallenge(appPool, "10006");
    const conflict = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10006", privateChatId: "10001", chatType: "private", code: collision.code
    });
    assert.deepEqual(conflict, { ok: false, reason: "ACCOUNT_LINK_CONFLICT" });

    // A database error after the insert attempt must roll back both the mapping and code use.
    const rollback = await issueTelegramLinkChallenge(appPool, "10008");
    await appPool.query(`
      CREATE OR REPLACE FUNCTION test_reject_autoflip_link_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced account-link integration test failure';
      END;
      $$;
      CREATE TRIGGER test_reject_autoflip_link_insert_trg
      BEFORE INSERT ON autonomous_telegram_account_links
      FOR EACH ROW WHEN (NEW.telegram_user_id='10008')
      EXECUTE FUNCTION test_reject_autoflip_link_insert();
    `);
    await assert.rejects(confirmTelegramAccountLink(appPool, {
      telegramUserId: "10008", privateChatId: "10008", chatType: "private", code: rollback.code
    }), /forced account-link integration test failure/);
    await appPool.query("DROP TRIGGER test_reject_autoflip_link_insert_trg ON autonomous_telegram_account_links");
    await appPool.query("DROP FUNCTION test_reject_autoflip_link_insert()");
    const retryAfterRollback = await confirmTelegramAccountLink(appPool, {
      telegramUserId: "10008", privateChatId: "10008", chatType: "private", code: rollback.code
    });
    assert.deepEqual(retryAfterRollback, { ok: true });

    // Issuance rate limit is enforced transactionally.
    for (let i = 0; i < 5; i++) await issueTelegramLinkChallenge(appPool, "10009");
    await assert.rejects(issueTelegramLinkChallenge(appPool, "10009"), /LINK_RATE_LIMITED/);

    await assert.rejects(issueTelegramLinkChallenge(appPool, "10001"), /ACCOUNT_ALREADY_LINKED/);
  } finally {
    if (appPool) await appPool.end();
    await adminPool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await adminPool.end();
  }
});
