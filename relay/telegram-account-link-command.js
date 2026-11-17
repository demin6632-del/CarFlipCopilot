"use strict";

const { confirmTelegramAccountLink } = require("./telegram-account-linking");

function getCommand(text) {
  return String(text || "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
}

/**
 * Handles /link CODE without exposing identifiers or echoing the submitted code.
 * The feature is deliberately disabled unless the operator explicitly enables it.
 */
async function handleTelegramLinkCommand(message, options = {}) {
  const text = String(message?.text || "").trim();
  if (getCommand(text) !== "/link") return false;

  const chatId = message?.chat?.id;
  if (chatId === undefined || chatId === null) return true;
  const send = options.send;
  if (typeof send !== "function") throw new Error("SEND_FUNCTION_REQUIRED");

  if (options.enabled !== true) {
    await send(chatId, "🔒 Привязка аккаунта пока отключена. Попробуй позже.");
    return true;
  }

  if (message?.chat?.type !== "private") {
    await send(chatId, "🔒 Для привязки открой личный чат с AUTOFLIP и отправь команду там.");
    return true;
  }

  const parts = text.split(/\s+/);
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{10,32}$/.test(parts[1])) {
    await send(chatId, "Использование: /link КОД\nПолучи одноразовый код в Mini App AUTOFLIP. Код действует ограниченное время.");
    return true;
  }

  const telegramUserId = message?.from?.id;
  if (telegramUserId === undefined || telegramUserId === null) {
    await send(chatId, "Не удалось подтвердить Telegram-аккаунт. Попробуй ещё раз.");
    return true;
  }

  try {
    const pool = typeof options.getPool === "function" ? await options.getPool() : options.pool;
    if (!pool || typeof pool.connect !== "function") throw new Error("DATABASE_POOL_REQUIRED");
    const result = await confirmTelegramAccountLink(pool, {
      telegramUserId: String(telegramUserId),
      privateChatId: String(chatId),
      chatType: "private",
      code: parts[1]
    });

    if (result.ok) {
      await send(chatId, "✅ Telegram-аккаунт успешно привязан к AUTOFLIP. Теперь можно открыть личный кабинет.");
    } else if (result.reason === "ACCOUNT_LINK_CONFLICT") {
      await send(chatId, "Этот Telegram-чат уже связан с другим аккаунтом. Обратись в поддержку.");
    } else if (result.reason === "ACCOUNT_ALREADY_LINKED") {
      await send(chatId, "Этот Telegram-аккаунт уже привязан к AUTOFLIP.");
    } else {
      await send(chatId, "❌ Код недействителен, истёк или не принадлежит этому Telegram-аккаунту. Запроси новый код в Mini App.");
    }
    return true;
  } catch (error) {
    if (error?.message === "INVALID_LINK_CODE") {
      await send(chatId, "❌ Неверный формат кода. Получи новый код в Mini App AUTOFLIP.");
      return true;
    }
    throw error;
  }
}

module.exports = { getCommand, handleTelegramLinkCommand };
