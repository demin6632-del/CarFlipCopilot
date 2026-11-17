"use strict";

const http = require("node:http");
const { Pool } = require("pg");
const { createWebAccountApi } = require("./web-account-api");

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function databasePoolOptions(env = process.env) {
  return {
    connectionString: env.DATABASE_URL,
    // Verify PostgreSQL certificates by default. Only explicitly disable TLS
    // for isolated local/test databases that do not provide TLS.
    ssl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
    statement_timeout: 7000
  };
}

function createWebAccountServer(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.query !== "function") throw new Error("DATABASE_POOL_REQUIRED");

  const handleAccount = createWebAccountApi({
    pool,
    botToken: options.botToken,
    webOrigin: options.webOrigin,
    now: options.now,
    onError: options.onError
  });

  const server = http.createServer(async (req, res) => {
    const path = String(req.url || "").split("?")[0];
    if (path === "/health" && req.method === "GET") {
      try {
        await pool.query("SELECT 1");
        json(res, 200, { ok: true, service: "autoflip-web-account-api" });
      } catch (error) {
        if (typeof options.onError === "function") options.onError(error);
        json(res, 503, { ok: false });
      }
      return;
    }

    try {
      const handled = await handleAccount(req, res);
      if (!handled && !res.writableEnded) json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (typeof options.onError === "function") options.onError(error);
      if (!res.writableEnded) json(res, 500, { error: "INTERNAL_ERROR" });
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

async function start() {
  const missing = ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "WEB_APP_ORIGIN"]
    .filter(name => !process.env[name]);
  if (missing.length) throw new Error("Required environment variables are missing: " + missing.join(", "));

  const pool = new Pool(databasePoolOptions());
  pool.on("error", error => {
    console.error("AUTOFLIP WEB API DATABASE POOL ERROR:", error?.message || error);
  });

  const server = createWebAccountServer({
    pool,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    webOrigin: process.env.WEB_APP_ORIGIN,
    onError: error => console.error("AUTOFLIP WEB API ERROR:", error?.message || error)
  });

  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await pool.end();
    throw new Error("PORT_INVALID");
  }

  server.listen(port, "0.0.0.0", () => {
    console.log("AUTOFLIP web account API listening on port " + port);
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("AUTOFLIP web API shutting down: " + signal);
    server.close(async () => {
      await pool.end().catch(error => console.error("AUTOFLIP WEB API POOL CLOSE ERROR:", error?.message || error));
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  start().catch(error => {
    console.error("AUTOFLIP web API startup failed:", error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { createWebAccountServer, databasePoolOptions, start };
