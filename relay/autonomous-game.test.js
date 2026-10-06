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

test("recommendation never returns a listing outside the current market", () => {
  const s = game.newState("test-player-6", "Tester");
  const r = game.recommendation(s);
  assert.ok(r.car);
  assert.ok(s.market.some(x => x.id === r.car.id));
});

console.log("Autonomous game tests: OK");
