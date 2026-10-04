const assert = require("assert");
const { parseState, decide } = require("./free-analyzer");
const { buildStrategy, actionType, parseContract } = require("./strategy-engine");

function test(name, fn) {
  try { fn(); console.log("PASS", name); }
  catch (e) { console.error("FAIL", name, e.stack || e); process.exitCode = 1; }
}

test("parse balance/garage/vehicle", () => {
  const s = parseState("💰 Баланс: 5 990 655 ₽\n🚗 Гараж: 1/3\nАвтомобиль: BMW 3 G20\nЦена: 2 100 000 ₽\n190 л.с.");
  assert.equal(s.balance, 5990655);
  assert.equal(s.garage, "1/3");
  assert.equal(s.vehicle.name, "BMW 3 G20");
  assert.equal(s.vehicle.price, 2100000);
  assert.equal(s.vehicle.hp, 190);
});

test("buyer screen never becomes blind sell command", () => {
  const s = parseState("Предложение покупателя: 2 820 000 ₽\nПо рукам");
  const d = decide(s, 90);
  assert.equal(d.action, "ПРОВЕРЬ ПРЕДЛОЖЕНИЕ ПОКУПАТЕЛЯ");
});

test("plate auction is recognized", () => {
  const s = parseState("Аукцион госномера С909СС 763\nСтавка: 1 250 000 ₽");
  assert.equal(s.contexts.explicitPlateAuction, true);
  assert.equal(decide(s, 90).action, "ПРОВЕРЬ СТАВКУ НА НОМЕР");
});

test("no unsupported action on generic state", () => {
  const s = parseState("💰 Баланс: 5 990 655 ₽\n🚗 Гараж: 1/3");
  assert.equal(decide(s, 90).action, "НЕТ ПОДТВЕРЖДЁННОГО ДЕЙСТВИЯ");
});

test("strategy accounts for renewal cost", () => {
  const strategy = buildStrategy(
    { raw_message: "Объявление", raw_text: "Объявление", buttons: ["Продлить объявление", "По рукам"] },
    [],
    { transactions: [{action:"Продлить объявление"}], vehicles: [{status:"active",full_cost:2821258}] }
  );
  const renew = strategy.alternatives.find(x => x.type === "renew");
  assert(renew && /1 500/.test(renew.scenario));
});

test("contract parsing", () => {
  const c = parseContract("Контракт: награда 200 000 ₽, максимум 2 500 000 ₽, от 300 л.с.");
  assert.equal(c.reward, 200000);
  assert.equal(c.maxPrice, 2500000);
  assert.equal(c.minHp, 300);
});

test("button classification", () => {
  assert.equal(actionType("Продлить объявление"), "renew");
  assert.equal(actionType("По рукам"), "sell");
  assert.equal(actionType("Аукцион номера"), "plate");
});

console.log("ALL CARFLIPCOPILOT SELF-TESTS PASSED");
