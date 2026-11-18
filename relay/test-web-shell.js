"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_ROOT = path.resolve(__dirname, "../web");
const API_ORIGIN = String(process.env.API_ORIGIN || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 10000);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "SAMEORIGIN",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function proxyApi(req, res, url) {
  if (!API_ORIGIN) return send(res, 503, "Test API is not configured.");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("allow", "GET, POST");
    return send(res, 405, "Method not allowed.");
  }

  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "origin", "user-agent"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }

  try {
    const target = new URL(url.pathname + url.search, API_ORIGIN);
    if (target.origin !== API_ORIGIN || !target.pathname.startsWith("/api/web/")) {
      return send(res, 404, "Not found.");
    }
    const chunks = [];
    if (req.method === "POST") {
      for await (const chunk of req) chunks.push(chunk);
    }
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(120000)
    });
    const responseHeaders = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    for (const name of ["content-type", "content-length"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const cookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    if (cookies.length) responseHeaders["set-cookie"] = cookies;
    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Test API proxy failed:", {
      name: error && error.name,
      code: error && error.cause && error.cause.code,
      message: error && error.message
    });
    if (!res.headersSent) send(res, 502, "Test API is temporarily unavailable.");
    else res.end();
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    return send(res, 405, "Method not allowed.");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    return send(res, 400, "Bad request.");
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/app" || pathname === "/app/") pathname = "/app.html";
  const filePath = path.resolve(WEB_ROOT, "." + pathname);
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    return send(res, 404, "Not found.");
  }
  let data;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return send(res, 404, "Not found.");
    data = await fs.promises.readFile(filePath);
  } catch (_) {
    return send(res, 404, "Not found.");
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": path.extname(filePath) === ".html" || path.basename(filePath) === "account-link.js"
      ? "no-store"
      : "public, max-age=300",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "SAMEORIGIN"
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  res.on("finish", () => {
    console.log("AUTOFLIP TEST WEB REQUEST", JSON.stringify({
      method: req.method,
      path: String(req.url || "/").split("?")[0],
      status: res.statusCode,
      durationMs: Date.now() - requestStartedAt
    }));
  });
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch (_) {
    return send(res, 400, "Bad request.");
  }
  if (url.pathname === "/health") return send(res, 200, JSON.stringify({ ok: true, service: "autoflip-test-web-shell" }), "application/json; charset=utf-8");
  if (url.pathname === "/api/web" || url.pathname.startsWith("/api/web/")) {
    return proxyApi(req, res, url);
  }
  return serveStatic(req, res, url);
});

server.requestTimeout = 130000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("AUTOFLIP test web shell listening on port " + PORT);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
