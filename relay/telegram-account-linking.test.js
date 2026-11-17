"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCode, hashLinkCode, createLinkCode
} = require("./telegram-account-linking");

test("normalizes code without changing its identity", () => {
  const code = createLinkCode();
  assert.equal(normalizeCode(" " + code.toLowerCase() + " "), code);
  assert.equal(hashLinkCode(code), hashLinkCode(" " + code.toLowerCase() + " "));
});

test("generated one-time codes have sufficient random material and valid alphabet", () => {
  const code = createLinkCode();
  assert.match(code, /^[A-Z0-9_-]{11}$/);
  assert.equal(new Set(Array.from({ length: 20 }, createLinkCode)).size > 1, true);
});

test("rejects malformed codes and identifiers", () => {
  assert.throws(() => hashLinkCode("short"), /INVALID_LINK_CODE/);
  assert.throws(() => hashLinkCode("contains spaces!"), /INVALID_LINK_CODE/);
});

test("different codes produce different stored digests", () => {
  assert.notEqual(hashLinkCode(createLinkCode()), hashLinkCode(createLinkCode()));
});
