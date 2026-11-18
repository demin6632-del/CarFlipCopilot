"use strict";

const http = require("node:http");
const { Pool } = require("pg");
const { handleTelegramLinkCommand } = require("./telegram-link-command");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PORT = Number(process.env.PORT || 10000);
const WEB_APP_URL = "https://autoflip-e2e-web-test.onrender.com/app";
const API = "https://api.telegram.org/bot" + TOKEN;
let offset = 0;
let stopping = false;
let pool;
let startupStage = "environment_check";

function health(res) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: true, service: "autoflip-test-link-bot" }));
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") return health(res);
  res.writeHead(404);
  res.end("Not found");
});

async function telegram(method, body) {
  const response = await fetch(API + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error("TELEGRAM_API_ERROR");
    error.telegramHttpStatus = response.status;
    error.telegramErrorCode = Number.isInteger(payload.error_code) ? payload.error_code : null;
    error.telegramDescription = typeof payload.description === "string"
      ? payload.description.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 100)
      : "unknown";
    throw error;
  }
  return payload.result;
}

async function send(chatId, message, replyMarkup) {
  const payload = { chat_id: chatId, text: String(message), disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await telegram("sendMessage", payload);
}

async function sendStart(chatId, chatType) {
  if (chatType !== "private") {
    await send(chatId, "Открой тестового бота в личном чате, чтобы запустить AUTOFLIP.");
    return;
  }
  await send(chatId,
    "Добро пожаловать в AUTOFLIP! Открой тестовый Mini App кнопкой ниже. После запуска перейди к привязке аккаунта и получи одноразовый код.",
    { inline_keyboard: [[{ text: "ОТКРЫТЬ AUTOFLIP", web_app: { url: WEB_APP_URL } }]] }
  );
}

async function handleUpdate(update) {
  const message = update && update.message;
  console.log("TEST TELEGRAM UPDATE RECEIVED message=" + Boolean(message) +
    " has_text=" + Boolean(message && typeof message.text === "string"));
  if (!message || typeof message.text !== "string") return;
  const command = message.text.trim().split(/\s/, 1)[0].split("@")[0].toLowerCase();
  if (command === "/start") {
    await sendStart(message.chat.id, message.chat.type);
    console.log("TEST TELEGRAM COMMAND PROCESSED command=/start");
    return;
  }
  if (command !== "/link") return;
  console.log("TEST TELEGRAM COMMAND RECEIVED command=/link");
  await handleTelegramLinkCommand(message, {
    pool,
    send,
    onError: () => console.error("TEST ACCOUNT LINK DATABASE OPERATION FAILED")
  });
  console.log("TEST TELEGRAM COMMAND HANDLER FINISHED command=/link");
}

async function poll() {
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 20,
        limit: 50,
        allowed_updates: ["message"]
      });
      for (const update of updates) {
        await handleUpdate(update);
        offset = Math.max(offset, Number(update.update_id) + 1);
      }
    } catch (error) {
      if (!stopping) {
        const status = Number.isInteger(error?.telegramHttpStatus) ? error.telegramHttpStatus : "none";
        const code = Number.isInteger(error?.telegramErrorCode) ? error.telegramErrorCode : "none";
        const description = typeof error?.telegramDescription === "string" ? error.telegramDescription : "unknown";
        console.error("TEST TELEGRAM POLLING ERROR status=" + status + " code=" + code + " description=" + description);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
}

async function start() {
  startupStage = "environment_check";
  if (!TOKEN) throw new Error("Required test bot token is missing");
  if (!process.env.DATABASE_URL) throw new Error("Required test database URL is missing");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
    statement_timeout: 7000
  });
  startupStage = "database_connection";
  await pool.query("SELECT 1");
  startupStage = "telegram_token_validation";
  await telegram("getMe", {});
  startupStage = "telegram_webhook_diagnostic";
  const webhookInfo = await telegram("getWebhookInfo", {});
  console.log("TEST TELEGRAM WEBHOOK DIAGNOSTIC configured=" + Boolean(webhookInfo && webhookInfo.url) +
    " pending_updates=" + (Number.isInteger(webhookInfo && webhookInfo.pending_update_count)
      ? webhookInfo.pending_update_count : "unknown"));
  startupStage = "health_server_start";
  server.listen(PORT, "0.0.0.0", () => {
    console.log("AUTOFLIP isolated test link bot health server listening on port " + PORT);
  });
  console.log("TEST TELEGRAM POLLING STARTED mode=getUpdates");
  await poll();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

start().catch(async (error) => {
  const safeCode = typeof error?.code === "string" ? error.code.replace(/[^A-Z0-9_:-]/gi, "").slice(0, 40) : "none";
  const safeName = typeof error?.name === "string" ? error.name.replace(/[^A-Z0-9_]/gi, "").slice(0, 30) : "Error";
  const failedStage = startupStage;
  const telegramStatus = Number.isInteger(error?.telegramHttpStatus) ? error.telegramHttpStatus : "none";
  const telegramCode = Number.isInteger(error?.telegramErrorCode) ? error.telegramErrorCode : "none";
  const telegramDescription = typeof error?.telegramDescription === "string" ? error.telegramDescription : "none";
  console.error("AUTOFLIP_TEST_STARTUP_FAILURE stage=" + failedStage + " name=" + safeName + " code=" + safeCode +
    " telegram_http=" + telegramStatus + " telegram_code=" + telegramCode + " telegram_description=" + telegramDescription);
  if (pool) await pool.end().catch(() => {});
  process.exitCode = 1;
});
