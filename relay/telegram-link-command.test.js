"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleTelegramLinkCommand, MESSAGES } = require("./telegram-link-command");

function message(text, type = "private", fromId = 12345, chatId = 12345) {
  return { text, from: { id: fromId }, chat: { id: chatId, type } };
}

test("link command is restricted to private chats before touching the database", async () => {
  const sent = [];
  let calls = 0;
  const handled = await handleTelegramLinkCommand(message("/link ABCDEF1234", "group"), {
    pool: {}, send: async (...args) => sent.push(args),
    confirm: async () => { calls++; }
  });
  assert.equal(handled, true);
  assert.equal(calls, 0);
  assert.equal(sent[0][1], MESSAGES.privateOnly);
});

test("link command explains the required syntax when code is missing", async () => {
  const sent = [];
  await handleTelegramLinkCommand(message("/link"), {
    pool: {}, send: async (...args) => sent.push(args)
  });
  assert.equal(sent[0][1], MESSAGES.usage);
});

test("link command passes the exact sender and private chat identity to confirmation", async () => {
  const sent = [];
  let input;
  await handleTelegramLinkCommand(message("/link AABBCCDDEEFF00112233445566778899", "private", 98765, 98765), {
    pool: {},
    send: async (...args) => sent.push(args),
    confirm: async (_pool, value) => { input = value; return { ok: true }; }
  });
  assert.deepEqual(input, {
    telegramUserId: "98765",
    privateChatId: "98765",
    chatType: "private",
    code: "AABBCCDDEEFF00112233445566778899"
  });
  assert.equal(sent[0][1], MESSAGES.success);
});

test("link command never reveals database errors to the Telegram user", async () => {
  const sent = [];
  const logged = [];
  await handleTelegramLinkCommand(message("/link AABBCCDDEEFF00112233445566778899"), {
    pool: {},
    send: async (...args) => sent.push(args),
    confirm: async () => { throw new Error("secret database connection string"); },
    onError: error => logged.push(error.message)
  });
  assert.equal(sent[0][1], MESSAGES.unavailable);
  assert.deepEqual(logged, ["secret database connection string"]);
  assert.equal(sent[0][1].includes("secret"), false);
});

test("link command maps invalid and conflicting links to safe messages", async () => {
  const sent = [];
  await handleTelegramLinkCommand(message("/link AABBCCDDEEFF00112233445566778899"), {
    pool: {}, send: async (...args) => sent.push(args),
    confirm: async () => ({ ok: false, reason: "ACCOUNT_LINK_CONFLICT" })
  });
  assert.equal(sent[0][1], MESSAGES.conflict);
});
