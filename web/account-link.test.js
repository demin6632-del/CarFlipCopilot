"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "account-link.js"), "utf8");
const NOW = 1_800_000_000_000;

function element() {
  const listeners = {};
  return {
    disabled: false, hidden: false, textContent: "", value: "",
    classList: { toggle() {} },
    addEventListener(name, fn) { listeners[name] = fn; },
    async click() { if (listeners.click) await listeners.click(); },
    focus() {}, select() {},
    _listeners: listeners
  };
}

function harness({ telegram = true, apiBase = "/", fetchImpl = async () => ({ ok: true, status: 200, async json() { return {}; } }), href = "https://preview.autoflip.example/" } = {}) {
  const nodes = {
    "[data-link-status]": element(),
    "[data-link-issue]": element(),
    "[data-link-verify]": element(),
    "[data-link-code-panel]": element(),
    "[data-link-code]": element(),
    "[data-link-copy]": element(),
    "[data-link-expiry]": element()
  };
  const root = { querySelector(selector) { return nodes[selector]; } };
  const timers = new Map();
  let timerId = 0;
  const calls = [];
  const webApp = telegram ? { initData: "signed-init-data", readyCalled: false, ready() { this.readyCalled = true; } } : null;
  const window = {
    location: { href },
    Telegram: webApp ? { WebApp: webApp } : undefined,
    AUTOFLIP_WEB_API_BASE: apiBase
  };
  const context = {
    window,
    document: { querySelector(selector) { return selector === "[data-account-link]" ? root : null; } },
    URL,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } },
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); },
    navigator: { clipboard: { async writeText(value) { context.copied = value; } } },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    console,
    Buffer
  };
  vm.runInNewContext(source, context, { filename: "account-link.js" });
  return { nodes, context, calls, timers, webApp };
}

function reply(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test("outside Telegram Mini App the panel is informational and sends no requests", () => {
  const app = harness({ telegram: false });
  assert.match(app.nodes["[data-link-status]"].textContent, /внутри Telegram Mini App/);
  assert.equal(app.nodes["[data-link-issue]"].disabled, true);
  assert.equal(app.calls.length, 0);
});

test("missing API configuration leaves account-link actions disabled", () => {
  const app = harness({ apiBase: "" });
  assert.match(app.nodes["[data-link-status]"].textContent, /сервер привязки ещё не подключён/);
  assert.equal(app.nodes["[data-link-issue]"].disabled, true);
  assert.equal(app.calls.length, 0);
});

test("cross-origin API configuration is rejected before any network request", () => {
  const app = harness({ apiBase: "https://api.other.example/" });
  assert.match(app.nodes["[data-link-status]"].textContent, /same-origin|том же домене|должен работать на том же домене/i);
  assert.equal(app.nodes["[data-link-issue]"].disabled, true);
  assert.equal(app.calls.length, 0);
});

test("valid challenge displays one-time code and five-minute expiry", async () => {
  const app = harness({
    fetchImpl: async () => reply(200, { ok: true, code: "A".repeat(32), expiresAt: Math.floor(NOW / 1000) + 300 })
  });
  assert.equal(app.webApp.readyCalled, true);
  await app.nodes["[data-link-issue]"].click();
  assert.equal(app.nodes["[data-link-code]"].value, "A".repeat(32));
  assert.equal(app.nodes["[data-link-code-panel]"].hidden, false);
  assert.match(app.nodes["[data-link-status]"].textContent, /Код готов/);
  assert.match(app.nodes["[data-link-expiry]"].textContent, /Код истекает через 5:00/);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0][0], "https://preview.autoflip.example/api/web/link-challenge");
  assert.equal(JSON.parse(app.calls[0][1].body).initData, "signed-init-data");
});

test("rate limit is shown as a safe user-facing message", async () => {
  const app = harness({ fetchImpl: async () => reply(429, { error: "LINK_RATE_LIMITED" }) });
  await app.nodes["[data-link-issue]"].click();
  assert.match(app.nodes["[data-link-status]"].textContent, /Лимит запросов исчерпан/);
  assert.equal(app.nodes["[data-link-code-panel]"].hidden, true);
});

test("successful bot confirmation creates session and loads player DTO", async () => {
  let count = 0;
  const app = harness({
    fetchImpl: async (url, options) => {
      count++;
      if (count === 1) return reply(200, { ok: true, code: "B".repeat(32), expiresAt: Math.floor(NOW / 1000) + 300 });
      if (count === 2) return reply(200, { ok: true, expiresAt: Math.floor(NOW / 1000) + 604800 });
      return reply(200, { ok: true, profile: { player: { displayName: "Tester" }, garage: [] } });
    }
  });
  await app.nodes["[data-link-issue]"].click();
  await app.nodes["[data-link-verify]"].click();
  assert.equal(count, 3);
  assert.equal(app.calls[1][0], "https://preview.autoflip.example/api/web/session");
  assert.equal(app.calls[2][0], "https://preview.autoflip.example/api/web/profile");
  assert.match(app.nodes["[data-link-status]"].textContent, /Аккаунт успешно привязан.*Tester/);
  assert.equal(app.nodes["[data-link-code-panel]"].hidden, true);
  assert.equal(app.nodes["[data-link-issue]"].disabled, true);
  assert.equal(app.nodes["[data-link-verify]"].disabled, true);
});

test("unconfirmed link keeps the code visible and offers retry", async () => {
  let count = 0;
  const app = harness({
    fetchImpl: async () => {
      count++;
      if (count === 1) return reply(200, { ok: true, code: "C".repeat(32), expiresAt: Math.floor(NOW / 1000) + 300 });
      return reply(403, { error: "TELEGRAM_ACCOUNT_NOT_LINKED" });
    }
  });
  await app.nodes["[data-link-issue]"].click();
  await app.nodes["[data-link-verify]"].click();
  assert.match(app.nodes["[data-link-status]"].textContent, /Привязка пока не найдена/);
  assert.equal(app.nodes["[data-link-code-panel]"].hidden, false);
  assert.equal(app.nodes["[data-link-verify]"].disabled, false);
});

test("copy button copies the one-time code without persisting it", async () => {
  const app = harness({
    fetchImpl: async () => reply(200, { ok: true, code: "D".repeat(32), expiresAt: Math.floor(NOW / 1000) + 300 })
  });
  await app.nodes["[data-link-issue]"].click();
  await app.nodes["[data-link-copy]"].click();
  assert.equal(app.context.copied, "D".repeat(32));
  assert.equal(app.context.localStorage, undefined);
  assert.equal(app.context.sessionStorage, undefined);
});
