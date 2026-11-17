"use strict";

function normalizeTelegramUserId(value) {
  const id = String(value ?? "");
  if (!/^[1-9]\\d{0,19}$/.test(id)) throw new Error("INVALID_TELEGRAM_ID");
  return id;
}

function safeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function safeText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

function toCarDto(car) {
  if (!car || typeof car !== "object" || Array.isArray(car)) return null;
  return {
    model: safeText(car.model, "Автомобиль", 100),
    year: safeInteger(car.year, 0, 1886, 2200),
    plate: safeText(car.plate, "—", 24),
    mileage: safeInteger(car.mileage),
    condition: safeInteger(car.condition, 0, 0, 100)
  };
}

function toProfileDto(state) {
  const player = state?.player && typeof state.player === "object" ? state.player : {};
  const garage = Array.isArray(state?.garage) ? state.garage : [];
  const capacity = safeInteger(player.garageCapacity, 0, 0, 1000);
  const cars = garage.slice(0, 50).map(toCarDto).filter(Boolean);

  return {
    player: {
      displayName: safeText(player.name, "Игрок AUTOFLIP", 48),
      level: safeInteger(player.level, 1, 1, 100000),
      xp: safeInteger(player.xp),
      respect: safeInteger(player.respect),
      balance: safeInteger(player.balance),
      debt: safeInteger(player.debt),
      garageCapacity: capacity,
      garageUsed: garage.length
    },
    garage: cars,
    garageTruncated: garage.length > cars.length,
    gameDay: safeInteger(state?.meta?.day, 1, 1, Number.MAX_SAFE_INTEGER)
  };
}

async function readLinkedTelegramProfile(pool, telegramUserId) {
  if (!pool || typeof pool.query !== "function") throw new Error("DATABASE_POOL_REQUIRED");
  const userId = normalizeTelegramUserId(telegramUserId);
  const result = await pool.query(
    `SELECT s.state
       FROM autonomous_telegram_account_links AS l
       JOIN autonomous_game_state AS s ON s.chat_id = l.private_chat_id
      WHERE l.telegram_user_id = $1
      LIMIT 1`,
    [userId]
  );
  if (!result?.rowCount || !result.rows?.[0]) return null;
  return toProfileDto(result.rows[0].state);
}

module.exports = {
  normalizeTelegramUserId,
  toCarDto,
  toProfileDto,
  readLinkedTelegramProfile
};
