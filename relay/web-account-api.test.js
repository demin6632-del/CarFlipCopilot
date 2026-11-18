"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createWebAccountApi, COOKIE_NAME } = require("./web-account-api");

const BOT_TOKEN = "123456:unit-test-token";
const ORIGIN = "https://preview.autoflip.example";
const NOW = 1_800_000_000_000;

function signedInitData(user, botToken = BOT_TOKEN, authDate = Math.floor(NOW / 1000)) {
  const values = new Map([
    ["auth_date", String(authDate)],
    ["query_id", "AAE-test"],
    ["user", JSON.stringify(user)]
  ]);
  const check = [...values.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...values, ["hash", hash]]).toString();
}

function request(method, url, headers = {}, body = "") {
  return {
    method, url, headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    }
  };
}

function response() {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
    json() { return JSON.parse(this.body); }
  };
}

function makePool({ linked = true, profile = true, session = true, rateAttempts = 1 } = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO autonomous_web_session_rate_limits/.test(sql)) {
        return {
          rowCount: linked ? 1 : 0,
          rows: linked ? [{ attempts: rateAttempts, window_started_at: new Date(NOW - 1000).toISOString() }] : []
        };
      }
      if (/INSERT INTO autonomous_web_sessions/.test(sql)) {
        return { rowCount: linked ? 1 : 0, rows: linked ? [{ telegram_user_id: "123456789" }] : [] };
      }
      if (/SELECT telegram_user_id/.test(sql)) {
        return { rowCount: session ? 1 : 0, rows: session ? [{ telegram_user_id: "123456789" }] : [] };
      }
      if (/SELECT s\.state/.test(sql)) {
        return {
          rowCount: profile ? 1 : 0,
          rows: profile ? [{
            state: {
              player: { name: "Tester", level: 3, balance: 42000, garageCapacity: 4 },
              garage: [{ model: "Lada Vesta", year: 2020, plate: "А123ВС 77", mileage: 45000, condition: 92 }]
            }
          }] : []
        };
      }
      if (/DELETE FROM autonomous_web_sessions/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected SQL: " + sql);
    }
  };
  return { pool, calls };
}

function apiFor(pool) {
  return createWebAccountApi({
    pool, botToken: BOT_TOKEN, webOrigin: ORIGIN, now: () => NOW
  });
}

test("session creation requires exact allowed Origin", async () => {
  const { pool, calls } = makePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/session", {
    origin: "https://attacker.example", "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("session creation rejects invalid Telegram initData", async () => {
  const { pool, calls } = makePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/session", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: "user=%7B%22id%22%3A123%7D&hash=bad" })), res);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("session creation refuses an account without an explicit link", async () => {
  const { pool } = makePool({ linked: false });
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/session", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 403);
  assert.equal(res.json().error, "TELEGRAM_ACCOUNT_NOT_LINKED");
  assert.equal(res.headers["set-cookie"], undefined);
});

test("session cookie is secure and profile returns only allowlisted data", async () => {
  const { pool, calls } = makePool();
  const api = apiFor(pool);
  const login = response();
  await api(request("POST", "/api/web/session", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789, first_name: "Test" }) })), login);

  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie.startsWith(COOKIE_NAME + "="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.equal(calls[0].params[0], "123456789");
  assert.equal(calls[1].params[1], Math.floor(NOW / 1000) + 7 * 24 * 60 * 60);
  assert.equal(calls[1].params[2], "123456789");

  const token = cookie.split(";")[0];
  const profile = response();
  await api(request("GET", "/api/web/profile", { cookie: token }), profile);
  assert.equal(profile.status, 200);
  assert.equal(profile.json().profile.player.displayName, "Tester");
  assert.equal(profile.json().profile.garage[0].model, "Lada Vesta");
  assert.equal(JSON.stringify(profile.json()).includes("telegram_user_id"), false);
  assert.equal(JSON.stringify(profile.json()).includes("hiddenDefects"), false);
  assert.equal(profile.headers["cache-control"], "no-store, private");
});


test("session creation is rate limited per linked Telegram account", async () => {
  const { pool, calls } = makePool({ rateAttempts: 11 });
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/session", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 429);
  assert.equal(res.json().error, "SESSION_RATE_LIMITED");
  assert.equal(res.headers["retry-after"], "3599");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT/);
});

test("profile rejects missing, malformed and expired sessions", async () => {
  const { pool } = makePool({ session: false });
  const api = apiFor(pool);
  const missing = response();
  await api(request("GET", "/api/web/profile"), missing);
  assert.equal(missing.status, 401);

  const malformed = response();
  await api(request("GET", "/api/web/profile", { cookie: COOKIE_NAME + "=not-a-session" }), malformed);
  assert.equal(malformed.status, 401);

  const expired = response();
  await api(request("GET", "/api/web/profile", { cookie: COOKIE_NAME + "=" + "a".repeat(43) }), expired);
  assert.equal(expired.status, 401);
  assert.equal(expired.json().error, "SESSION_EXPIRED");
});

test("logout requires same Origin and revokes the stored hash", async () => {
  const { pool, calls } = makePool();
  const api = apiFor(pool);
  const token = "b".repeat(43);
  const denied = response();
  await api(request("POST", "/api/web/logout", {
    cookie: COOKIE_NAME + "=" + token, origin: "https://evil.example"
  }), denied);
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);

  const ok = response();
  await api(request("POST", "/api/web/logout", {
    cookie: COOKIE_NAME + "=" + token, origin: ORIGIN
  }), ok);
  assert.equal(ok.status, 200);
  assert.match(ok.headers["set-cookie"], /Max-Age=0/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], crypto.createHash("sha256").update(token).digest("hex"));
});


function makeChallengePool({ linked = false, issueCount = 0 } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT pg_advisory_xact_lock/.test(sql)) return { rowCount: 1, rows: [] };
      if (/SELECT 1 FROM autonomous_telegram_account_links/.test(sql)) {
        return { rowCount: linked ? 1 : 0, rows: linked ? [{ "?column?": 1 }] : [] };
      }
      if (/SELECT count\(\*\)::int AS issue_count/.test(sql)) {
        return { rowCount: 1, rows: [{ issue_count: issueCount }] };
      }
      if (/UPDATE autonomous_telegram_link_challenges/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO autonomous_telegram_link_challenges/.test(sql)) {
        return { rowCount: 1, rows: [{ expires_at: new Date(NOW + 5 * 60 * 1000).toISOString() }] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); }
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
      async query() { throw new Error("Direct pool query must not be used for challenge transaction"); }
    }
  };
}

test("link challenge endpoint requires the exact allowed Origin", async () => {
  const { pool, calls } = makeChallengePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: "https://attacker.example", "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("link challenge endpoint rejects invalid Telegram initData without DB access", async () => {
  const { pool, calls } = makeChallengePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: "user=bad&hash=bad" })), res);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("link challenge endpoint issues one-time code for the verified Telegram identity", async () => {
  const { pool, calls } = makeChallengePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789, first_name: "Test" }) })), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.match(res.json().code, /^[A-F0-9]{32}$/);
  assert.equal(res.json().expiresAt, Math.floor(NOW / 1000) + 300);
  const insert = calls.find(call => /INSERT INTO autonomous_telegram_link_challenges/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[0], "123456789");
  assert.notEqual(insert.params[1], res.json().code);
  assert.equal(calls.some(call => call.sql === "COMMIT"), true);
});

test("link challenge endpoint refuses already linked accounts and rate-limits issuance", async () => {
  const linked = makeChallengePool({ linked: true });
  const linkedApi = apiFor(linked.pool);
  const already = response();
  await linkedApi(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), already);
  assert.equal(already.status, 409);
  assert.equal(already.json().error, "ACCOUNT_ALREADY_LINKED");

  const limited = makeChallengePool({ issueCount: 5 });
  const limitedApi = apiFor(limited.pool);
  const rate = response();
  await limitedApi(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), rate);
  assert.equal(rate.status, 429);
  assert.equal(rate.json().error, "LINK_RATE_LIMITED");
  assert.equal(limited.calls.some(call => /INSERT INTO autonomous_telegram_link_challenges/.test(call.sql)), false);
});

test("unknown routes are left to the hosting application", async () => {
  const api = apiFor(makePool().pool);
  assert.equal(await api(request("GET", "/health"), response()), false);
});

test("marketplace browse requires a valid web session and returns only public listing data", async () => {
  const token = "c".repeat(43);
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const calls = [];
  const pool = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (/SELECT telegram_user_id/.test(sql)) return { rowCount: 1, rows: [{ telegram_user_id: "123456789" }] };
    if (/FROM autonomous_marketplace_listings/.test(sql)) return { rowCount: 1, rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      seller_chat_id: "private-chat-secret",
      asking_price: "1250000",
      status: "active",
      vehicle_snapshot: { model: "Lada Vesta", year: 2020, plate: "А123ВС 77", mileage: 45000, condition: 92 },
      created_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 86400000).toISOString()
    }] };
    throw new Error("Unexpected SQL: " + sql);
  }};
  const api = apiFor(pool);
  const res = response();
  await api(request("GET", "/api/web/marketplace?limit=5&search=Vesta", { cookie: COOKIE_NAME + "=" + token, origin: ORIGIN }), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().listings.length, 1);
  assert.equal(res.json().listings[0].vehicle.model, "Lada Vesta");
  assert.equal(JSON.stringify(res.json()).includes("private-chat-secret"), false);
  assert.deepEqual(calls[1].params, ["%Vesta%", 5, 0]);
});

test("marketplace endpoints reject invalid pagination and require a linked seller account", async () => {
  const token = "d".repeat(43);
  const pool = { async query(sql) {
    if (/SELECT telegram_user_id/.test(sql)) return { rowCount: 1, rows: [{ telegram_user_id: "123456789" }] };
    if (/SELECT private_chat_id/.test(sql)) return { rowCount: 0, rows: [] };
    throw new Error("Unexpected SQL: " + sql);
  }};
  const api = apiFor(pool);
  const invalid = response();
  await api(request("GET", "/api/web/marketplace?limit=999", { cookie: COOKIE_NAME + "=" + token, origin: ORIGIN }), invalid);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json().error, "INVALID_PAGINATION");

  const mine = response();
  await api(request("GET", "/api/web/marketplace/mine", { cookie: COOKIE_NAME + "=" + token, origin: ORIGIN }), mine);
  assert.equal(mine.status, 401);
  assert.equal(mine.json().error, "ACCOUNT_LINK_REQUIRED");
});
