"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLinkCode, hashLinkCode } = require("./telegram-account-linking");
const { getCommand, handleTelegramLinkCommand } = require("./telegram-account-link-command");

function makeMessage(text, overrides = {}) {
  return {
    text,
    from: { id: 123456789 },
    chat: { id: 123456789, type: "private" },
    ...overrides
  };
}

function fakePool(responses) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      const next = responses.shift();
      if (!next) throw new Error("Unexpected SQL: " + sql);
      return next;
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test("recognizes /link with an optional bot mention", () => {
  assert.equal(getCommand("/link ABCDEF1234567890"), "/link");
  assert.equal(getCommand("/link@CarFlipCopilotBot ABCDEF1234567890"), "/link");
  assert.equal(getCommand("/help"), "/help");
});

test("link command is safely disabled by default", async () => {
  const sent = [];
  let poolRequested = false;
  const handled = await handleTelegramLinkCommand(makeMessage("/link " + createLinkCode()), {
    send: async (...args) => sent.push(args),
    getPool: async () => { poolRequested = true; throw new Error("MUST_NOT_CONNECT"); }
  });
  assert.equal(handled, true);
  assert.equal(poolRequested, false);
  assert.match(sent[0][1], /пока отключена/);
});

test("link command rejects group chats before accessing the database", async () => {
  const sent = [];
  let poolRequested = false;
  await handleTelegramLinkCommand(makeMessage("/link " + createLinkCode(), {
    chat: { id: -100123, type: "supergroup" }
  }), {
    enabled: true,
    send: async (...args) => sent.push(args),
    getPool: async () => { poolRequested = true; return null; }
  });
  assert.equal(poolRequested, false);
  assert.match(sent[0][1], /личный чат/);
});

test("link command validates code syntax and never echoes submitted values", async () => {
  const sent = [];
  let poolRequested = false;
  const secret = "bad-code-DO-NOT-ECHO";
  await handleTelegramLinkCommand(makeMessage("/link " + secret), {
    enabled: true,
    send: async (...args) => sent.push(args),
    getPool: async () => { poolRequested = true; return null; }
  });
  assert.equal(poolRequested, false);
  assert.equal(sent.some(item => item.join(" ").includes(secret)), false);
  assert.match(sent[0][1], /Использование/);
});

test("link command redeems a valid code for the exact Telegram user in a private chat", async () => {
  const code = createLinkCode();
  const { pool, calls } = fakePool([
    { rowCount: 1, rows: [{ id: "challenge-1", telegram_user_id: "123456789", usable: true }] },
    { rowCount: 1, rows: [{ telegram_user_id: "123456789" }] },
    { rowCount: 1, rows: [] }
  ]);
  const sent = [];
  const handled = await handleTelegramLinkCommand(makeMessage("/link@" + "CarFlipCopilotBot " + code), {
    enabled: true,
    pool,
    send: async (...args) => sent.push(args)
  });
  assert.equal(handled, true);
  assert.match(sent[0][1], /успешно привязан/);
  const insert = calls.find(call => call.sql.startsWith("INSERT INTO autonomous_telegram_account_links"));
  assert.deepEqual(insert.params, ["123456789", "123456789"]);
  assert.equal(calls.some(call => call.params.includes(code)), false);
  assert.equal(calls.some(call => call.params.includes(hashLinkCode(code))), true);
});

test("link command reports invalid or expired code without leaking it", async () => {
  const code = createLinkCode();
  const { pool } = fakePool([
    { rowCount: 1, rows: [{ id: "challenge-2", telegram_user_id: "999999999", usable: true }] }
  ]);
  const sent = [];
  await handleTelegramLinkCommand(makeMessage("/link " + code), {
    enabled: true,
    pool,
    send: async (...args) => sent.push(args)
  });
  assert.match(sent[0][1], /недействителен/);
  assert.equal(sent[0][1].includes(code), false);
});

test("link command does not claim success when database access fails", async () => {
  const sent = [];
  await assert.rejects(handleTelegramLinkCommand(makeMessage("/link " + createLinkCode()), {
    enabled: true,
    getPool: async () => { throw new Error("DB_OFFLINE"); },
    send: async (...args) => sent.push(args)
  }), /DB_OFFLINE/);
  assert.equal(sent.length, 0);
});
