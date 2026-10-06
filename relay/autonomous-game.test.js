const assert = require("node:assert/strict");
const game = require("./autonomous-game");

function test(name, fn) {
  fn();
  console.log("PASS:", name);
}

test("new player starts with stable economy", () => {
  const s = game.newState("test-player-1", "Tester");
  assert.equal(s.player.balance, 3000000);
  assert.equal(s.player.level, 1);
  assert.equal(s.player.xp, 0);
  assert.equal(s.garage.length, 0);
  assert.equal(s.market.length, 5);
  assert.equal(s.player.garageCapacity, 3);
});

test("market listings have valid original game data", () => {
  const s = game.newState("test-player-2", "Tester");
  for (const car of s.market) {
    assert.ok(car.id);
    assert.ok(car.buyPrice > 0);
    assert.ok(car.targetSale > 0);
    assert.ok(car.condition >= 78 && car.condition <= 98);
    assert.ok(car.risk >= 0 && car.risk <= 0.8);
  }
});

test("ledger changes balance exactly once per transaction", () => {
  const s = game.newState("test-player-3", "Tester");
  const start = s.player.balance;
  game.addTx(s, "buy", -700000, "test purchase");
  assert.equal(s.player.balance, start - 700000);
  game.addTx(s, "repair", -50000, "test repair");
  assert.equal(s.player.balance, start - 750000);
  game.addTx(s, "sale", 900000, "test sale");
  assert.equal(s.player.balance, start + 150000);
  assert.equal(s.transactions.length, 3);
});

test("progression awards XP and levels", () => {
  const s = game.newState("test-player-4", "Tester");
  const p = game.addProgress(s, 500000);
  assert.ok(p.gainedXp > 0);
  assert.ok(s.player.xp > 0);
  for (let i = 0; i < 5; i++) game.addProgress(s, 500000);
  assert.ok(s.player.level >= 2);
});

test("contract reward is represented as a separate ledger credit", () => {
  const s = game.newState("test-player-5", "Tester");
  const before = s.player.balance;
  game.addTx(s, "contract", s.contracts[0].reward, "contract reward");
  assert.equal(s.player.balance, before + 120000);
  assert.equal(s.transactions[0].kind, "contract");
});

test("buyer offer stays positive and follows target economics", () => {
  const s = game.newState("test-player-offer", "Tester");
  const car = s.market[0];
  const offer = game.buyerOffer(s, car);
  assert.ok(offer > 0);
  assert.ok(offer < car.targetSale * 1.2);
});

test("market demand cycle stays within safe bounds", () => {
  const s = game.newState("test-player-demand", "Tester");
  for (let i = 0; i < 20; i++) {
    s.meta.turn = i;
    game.refreshMarket(s);
    for (const car of s.market) assert.ok(car.currentDemand >= 0.45 && car.currentDemand <= 0.98);
  }
});

test("deal events are bounded", () => {
  const s = game.newState("test-player-events", "Tester");
  const car = s.market[0];
  for (let i = 0; i < 50; i++) {
    const event = game.dealRisk(s, car);
    assert.ok(["normal","incident","bonus"].includes(event.type));
    if (event.penalty !== undefined) assert.ok(event.penalty >= 9000 && event.penalty <= 45000);
    if (event.bonus !== undefined) assert.ok(event.bonus >= 12000 && event.bonus <= 42000);
  }
});

test("recommendation never returns a listing outside the current market", () => {
  const s = game.newState("test-player-6", "Tester");
  const r = game.recommendation(s);
  assert.ok(r.car);
  assert.ok(s.market.some(x => x.id === r.car.id));
});

console.log("Autonomous game tests: OK");


test("original contracts track real progression", () => {
  const s = game.newState("contract-player", "Tester");
  assert.equal(s.contracts.length, 3);
  game.addTx(s, "sale", 1200000, "Продажа тестовой машины (прибыль 300000 ₽)");
  game.addTx(s, "sale", 1300000, "Продажа второй машины (прибыль 400000 ₽)");
  s.player.respect = 10;
  game.updateContracts(s, 400000);
  assert.ok(s.contracts.find(x => x.id==="profit_300k").completed);
  assert.ok(s.contracts.find(x => x.id==="two_sales").completed);
  assert.ok(s.contracts.find(x => x.id==="respect_10").completed);
  assert.ok(s.transactions.filter(x => x.kind==="contract").length >= 3);
});

test("plate market and warehouse are isolated per player state", () => {
  const a = game.newState("plate-a", "A");
  const b = game.newState("plate-b", "B");
  assert.ok(Array.isArray(a.plateMarket));
  assert.ok(a.plateMarket.length >= 3);
  assert.ok(Array.isArray(a.plateWarehouse));
  assert.notEqual(a.plateMarket[0].plate, undefined);
  assert.notEqual(b.plateMarket[0].plate, undefined);
  a.plateWarehouse.push({id:"p1",plate:"А123ВС 77",cost:50000});
  assert.equal(b.plateWarehouse.length, 0);
});

test("plate prices are positive and bounded", () => {
  const s = game.newState("plate-prices", "Tester");
  for (const p of s.plateMarket) {
    assert.ok(p.buyPrice >= 12000);
    assert.ok(p.quality >= 55 && p.quality <= 100);
    assert.ok(p.rarity >= 0.7 && p.rarity <= 2.2);
  }
});
