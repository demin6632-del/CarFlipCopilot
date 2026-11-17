"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createWebAccountApi, COOKIE_NAME } = require("./web-account-api");
const { hashLinkCode } = require("./telegram-account-linking");

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

test("unknown routes are left to the hosting application", async () => {
  const api = apiFor(makePool().pool);
  assert.equal(await api(request("GET", "/health"), response()), false);
});


function makeLinkChallengePool({ linked = false, issueCount = 0 } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (/pg_advisory_xact_lock/.test(sql)) return { rowCount: 1, rows: [] };
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
    release() { calls.push({ sql: "RELEASE" }); }
  };
  const pool = {
    async query() { return { rowCount: 1, rows: [] }; },
    async connect() { return client; }
  };
  return { pool, calls };
}

test("link challenge endpoint issues a one-time code only for signed Telegram initData", async () => {
  const { pool, calls } = makeLinkChallengePool();
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789, first_name: "Test" }) })), res);

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.match(res.json().code, /^[A-F0-9]{32}$/);
  assert.ok(Date.parse(res.json().expiresAt) > NOW);
  const insert = calls.find(call => call.sql.startsWith("INSERT INTO autonomous_telegram_link_challenges"));
  assert.ok(insert);
  assert.equal(insert.params[1], hashLinkCode(res.json().code));
  assert.equal(calls.some(call => call.params.includes(res.json().code)), false);
});

test("link challenge endpoint rejects an already linked Telegram account", async () => {
  const { pool, calls } = makeLinkChallengePool({ linked: true });
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 409);
  assert.equal(res.json().error, "TELEGRAM_ACCOUNT_ALREADY_LINKED");
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO autonomous_telegram_link_challenges")), false);
});

test("link challenge endpoint enforces its issuance rate limit", async () => {
  const { pool, calls } = makeLinkChallengePool({ issueCount: 5 });
  const api = apiFor(pool);
  const res = response();
  await api(request("POST", "/api/web/link-challenge", {
    origin: ORIGIN, "content-type": "application/json"
  }, JSON.stringify({ initData: signedInitData({ id: 123456789 }) })), res);
  assert.equal(res.status, 429);
  assert.equal(res.json().error, "LINK_RATE_LIMITED");
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO autonomous_telegram_link_challenges")), false);
});
