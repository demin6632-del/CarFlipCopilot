"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTelegramUserId,
  toCarDto,
  toProfileDto,
  readLinkedTelegramProfile
} = require("./telegram-account-profile");

test("Telegram IDs are validated without numeric coercion", () => {
  assert.equal(normalizeTelegramUserId("12345678901234567890"), "12345678901234567890");
  assert.throws(() => normalizeTelegramUserId("0"), /INVALID_TELEGRAM_ID/);
  assert.throws(() => normalizeTelegramUserId("12x"), /INVALID_TELEGRAM_ID/);
});

test("profile DTO exposes only allowlisted player and garage fields", () => {
  const dto = toProfileDto({
    player: {
      name: "Игрок", level: 4, xp: 25, respect: 8, balance: 123456,
      debt: 500, garageCapacity: 3, secretToken: "must-not-leak"
    },
    garage: [{
      id: "internal-id", model: "Lada Vesta", year: 2019, plate: "А123ВС 77",
      mileage: 82000, condition: 91, buyPrice: 700000, hiddenDefects: 2
    }],
    meta: { day: 7, seed: 12345 }
  });

  assert.deepEqual(dto, {
    player: {
      displayName: "Игрок", level: 4, xp: 25, respect: 8, balance: 123456,
      debt: 500, garageCapacity: 3, garageUsed: 1
    },
    garage: [{
      model: "Lada Vesta", year: 2019, plate: "А123ВС 77", mileage: 82000, condition: 91
    }],
    garageTruncated: false,
    gameDay: 7
  });
  assert.equal(JSON.stringify(dto).includes("secretToken"), false);
  assert.equal(JSON.stringify(dto).includes("hiddenDefects"), false);
  assert.equal(JSON.stringify(dto).includes("internal-id"), false);
});

test("invalid car entries are skipped and garage output is capped", () => {
  assert.equal(toCarDto(null), null);
  const garage = Array.from({ length: 55 }, (_, i) => ({ model: "Car " + i }));
  const dto = toProfileDto({ player: {}, garage });
  assert.equal(dto.garage.length, 50);
  assert.equal(dto.garageTruncated, true);
});

test("reader uses a parameterized SELECT and returns null for unlinked users", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    }
  };

  assert.equal(await readLinkedTelegramProfile(pool, "12345"), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["12345"]);
  assert.match(calls[0].sql, /^\\s*SELECT/i);
  assert.match(calls[0].sql, /autonomous_telegram_account_links/);
  assert.match(calls[0].sql, /autonomous_game_state/);
  assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|DELETE|FOR UPDATE/i);
});

test("reader returns the allowlisted DTO for the linked profile", async () => {
  const pool = {
    async query(_sql, params) {
      assert.deepEqual(params, ["98765"]);
      return {
        rowCount: 1,
        rows: [{
          state: {
            player: { name: "Driver", level: 2, balance: 9000, garageCapacity: 3 },
            garage: [{ model: "BMW X1", year: 2015, plate: "В555ОР 05", mileage: 100000, condition: 80 }]
          }
        }]
      };
    }
  };

  const dto = await readLinkedTelegramProfile(pool, "98765");
  assert.equal(dto.player.displayName, "Driver");
  assert.equal(dto.player.balance, 9000);
  assert.equal(dto.garage[0].model, "BMW X1");
});
