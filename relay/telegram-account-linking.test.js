"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCode, hashLinkCode, createLinkCode,
  issueTelegramLinkChallenge, confirmTelegramAccountLink
} = require("./telegram-account-linking");

class FakePool {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
    this.released = false;
  }
  async connect() { return this; }
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    const next = this.responses.shift();
    if (!next) throw new Error("Unexpected SQL: " + sql);
    if (next.error) throw next.error;
    return next;
  }
  release() { this.released = true; }
}

test("normalizes code without changing its identity", () => {
  const code = createLinkCode();
  assert.equal(normalizeCode(" " + code.toLowerCase() + " "), code);
  assert.equal(hashLinkCode(code), hashLinkCode(" " + code.toLowerCase() + " "));
});

test("generated one-time codes have sufficient random material and valid alphabet", () => {
  const code = createLinkCode();
  assert.match(code, /^[A-F0-9]{16}$/g);
  assert.equal(new Set(Array.from({ length: 20 }, createLinkCode)).size > 1, true);
});

test("rejects malformed codes and identifiers", () => {
  assert.throws(() => hashLinkCode("short"), /INVALID_LINK_CODE/);
  assert.throws(() => hashLinkCode("contains spaces!"), /INVALID_LINK_CODE/);
});

test("different codes produce different stored digests", () => {
  assert.notEqual(hashLinkCode(createLinkCode()), hashLinkCode(createLinkCode()));
});

test("challenge creation stores only a digest and commits atomically", async () => {
  const pool = new FakePool([
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ issue_count: 0 }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ expires_at: "2030-01-01T00:05:00.000Z" }] }
  ]);
  const result = await issueTelegramLinkChallenge(pool, 123456789, { now: 0 });
  assert.match(result.code, /^[A-Z0-9_-]{11}$/);
  assert.equal(pool.calls.at(-1).params[1], hashLinkCode(result.code));
  assert.equal(pool.calls.some(call => call.params.includes(result.code)), false);
  assert.equal(pool.calls.at(-1).sql.includes("now()+"), true);
  assert.equal(pool.calls.some(call => call.sql === "COMMIT"), true);
  assert.equal(pool.released, true);
});

test("challenge issuance rolls back when the account is already linked", async () => {
  const pool = new FakePool([{ rowCount: 1, rows: [{ "?column?": 1 }] }]);
  await assert.rejects(issueTelegramLinkChallenge(pool, "123456789"), /ACCOUNT_ALREADY_LINKED/);
  assert.equal(pool.calls.some(call => call.sql === "ROLLBACK"), true);
  assert.equal(pool.calls.some(call => call.sql === "COMMIT"), false);
});

test("confirmation is restricted to private chats before opening a transaction", async () => {
  const pool = new FakePool([]);
  await assert.rejects(confirmTelegramAccountLink(pool, {
    telegramUserId: "123456789", privateChatId: "123456789",
    chatType: "group", code: createLinkCode()
  }), /PRIVATE_CHAT_REQUIRED/);
  assert.equal(pool.calls.length, 0);
});

test("confirmation links the matching Telegram identity and consumes the code atomically", async () => {
  const code = createLinkCode();
  const pool = new FakePool([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ id: "challenge-1", telegram_user_id: "123456789", usable: true }] },
    { rowCount: 1, rows: [{ telegram_user_id: "123456789" }] },
    { rowCount: 1, rows: [] }
  ]);
  const result = await confirmTelegramAccountLink(pool, {
    telegramUserId: "123456789", privateChatId: "123456789",
    chatType: "private", code
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(pool.calls[2].params[0], "123456789");
  assert.equal(pool.calls[2].params[1], "123456789");
  assert.equal(pool.calls[3].params[0], "challenge-1");
  assert.equal(pool.calls.some(call => call.sql === "COMMIT"), true);
  assert.equal(pool.released, true);
});

test("confirmation rejects a code belonging to another Telegram account", async () => {
  const pool = new FakePool([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ id: "challenge-2", telegram_user_id: "999", usable: true }] }
  ]);
  const result = await confirmTelegramAccountLink(pool, {
    telegramUserId: "123456789", privateChatId: "123456789",
    chatType: "private", code: createLinkCode()
  });
  assert.deepEqual(result, { ok: false, reason: "INVALID_OR_EXPIRED_CODE" });
  assert.equal(pool.calls.some(call => call.sql === "COMMIT"), true);
  assert.equal(pool.calls.some(call => call.sql.startsWith("INSERT INTO autonomous_telegram_account_links")), false);
});
