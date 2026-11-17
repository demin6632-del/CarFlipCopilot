"use strict";

const { confirmTelegramAccountLink } = require("./telegram-account-linking");

const MESSAGES = {
  usage: "Формат команды: /link КОД\n\nОткрой AUTOFLIP внутри Telegram, получи одноразовый код привязки и отправь его сюда в личном чате.",
  privateOnly: "🔒 Привязка доступна только в личном чате с ботом.",
  invalid: "❌ Код недействителен, истёк или выпущен для другого Telegram-аккаунта. Получи новый код в AUTOFLIP.",
  already: "ℹ️ Этот Telegram-аккаунт уже привязан к игровому профилю.",
  conflict: "❌ Этот игровой профиль или личный чат уже связан с другой учётной записью. Обратись в поддержку.",
  success: "✅ Telegram-аккаунт успешно привязан к игровому профилю AUTOFLIP.",
  unavailable: "⚠️ Сервис привязки временно недоступен. Попробуй позже."
};

async function handleTelegramLinkCommand(message, options = {}) {
  const send = options.send;
  const pool = options.pool;
  const confirm = options.confirm || confirmTelegramAccountLink;
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  const parts = String(message?.text || "").trim().split(/\s+/);
  const code = parts.length === 2 ? parts[1] : "";

  if (chatId == null || typeof send !== "function") return false;
  if (message?.chat?.type !== "private") {
    await send(chatId, MESSAGES.privateOnly);
    return true;
  }
  if (!code) {
    await send(chatId, MESSAGES.usage);
    return true;
  }
  if (parts.length !== 2 || fromId == null || !pool) {
    await send(chatId, pool ? MESSAGES.usage : MESSAGES.unavailable);
    return true;
  }

  try {
    const result = await confirm(pool, {
      telegramUserId: String(fromId),
      privateChatId: String(chatId),
      chatType: "private",
      code
    });
    if (result?.ok) await send(chatId, MESSAGES.success);
    else if (result?.reason === "ACCOUNT_ALREADY_LINKED") await send(chatId, MESSAGES.already);
    else if (result?.reason === "ACCOUNT_LINK_CONFLICT") await send(chatId, MESSAGES.conflict);
    else await send(chatId, MESSAGES.invalid);
  } catch (error) {
    if (error?.message === "INVALID_LINK_CODE" || error?.message === "INVALID_TELEGRAM_ID") {
      await send(chatId, MESSAGES.invalid);
    } else {
      if (typeof options.onError === "function") options.onError(error);
      await send(chatId, MESSAGES.unavailable);
    }
  }
  return true;
}

module.exports = { MESSAGES, handleTelegramLinkCommand };
