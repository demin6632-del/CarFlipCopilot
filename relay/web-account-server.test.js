"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebAccountServer } = require("./web-account-server");

async function withServer(server, run) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("dedicated web account server exposes a minimal database-backed health route", async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rowCount: 1, rows: [{ "?column?": 1 }] };
    }
  };
  const server = createWebAccountServer({
    pool, botToken: "test-token", webOrigin: "https://preview.autoflip.example"
  });

  await withServer(server, async base => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, service: "autoflip-web-account-api"
    });
  });
  assert.deepEqual(calls, ["SELECT 1"]);
});

test("dedicated server does not expose the legacy relay endpoints", async () => {
  const pool = { async query() { return { rowCount: 1, rows: [] }; } };
  const server = createWebAccountServer({
    pool, botToken: "test-token", webOrigin: "https://preview.autoflip.example"
  });

  await withServer(server, async base => {
    for (const route of ["/state", "/ws", "/bridge/state", "/attachments"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 404, route + " must not be exposed");
    }
  });
});

test("health route returns 503 without leaking database errors", async () => {
  const pool = { async query() { throw new Error("sensitive database details"); } };
  const server = createWebAccountServer({
    pool, botToken: "test-token", webOrigin: "https://preview.autoflip.example"
  });

  await withServer(server, async base => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  });
});
