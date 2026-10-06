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
  assert.equal(s.pendingDeal, null);
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
  assert.equal(s.player.balance, before + s.contracts[0].reward);
  assert.equal(s.transactions[0].kind, "contract");
});

test("buyer offer stays positive and follows target economics", () => {
  const s = game.newState("test-player-offer", "Tester");
  const car = s.market[0];
  const offer = game.buyerOffer(s, car);
  assert.ok(offer > 0);
  assert.ok(offer < car.targetSale * 1.2);
});

test("buyer profiles are original and bounded", () => {
  const s = game.newState("buyer-types", "Tester");
  const car = s.market[0];
  for (let i = 0; i < 30; i++) {
    const d = game.buyerOfferDetails(s, car);
    assert.ok(game.BUYER_TYPES.some(x => x.id === d.typeId));
    assert.ok(d.amount > 0);
    assert.ok(d.demand >= 45 && d.demand <= 98);
    assert.ok(d.condition >= 0 && d.condition <= 100);
    assert.ok(d.reputation >= 0 && d.reputation <= 50);
  }
});

test("negotiation stays bounded and never invents arbitrary money", () => {
  const s = game.newState("negotiation-bounds", "Tester");
  const car = s.market[0];
  const deal = game.buyerOfferDetails(s, car);
  const result = game.negotiation(s, car, {...deal});
  assert.ok(result.amount >= deal.amount);
  assert.ok(result.amount <= Math.round(deal.amount * 1.06) + 1000);
  const finished = {...deal, negotiations:1};
  const second = game.negotiation(s, car, finished);
  assert.equal(second.amount, deal.amount);
});

test("rejecting a pending deal does not change balance or garage", () => {
  const s = game.newState("reject-deal", "Tester");
  const car = s.market[0];
  const beforeBalance = s.player.balance;
  const beforeGarage = s.garage.length;
  const deal = game.buyerOfferDetails(s, car);
  s.pendingDeal = {...deal, carId:car.id};
  s.pendingDeal = null;
  assert.equal(s.player.balance, beforeBalance);
  assert.equal(s.garage.length, beforeGarage);
});

test("accepted profitable deal changes garage, ledger and pending state exactly once", () => {
  const s = game.newState("accept-deal", "Tester");
  const car = s.market[0];
  const owned = {...car, status:"owned", repairSpent:0, extraSpent:0, diagnosticsSpent:0};
  s.market = s.market.filter(x => x.id !== car.id);
  s.garage.push(owned);
  const offer = game.vehicleCost(owned) + 50000;
  const before = s.player.balance;
  s.pendingDeal = {carId:owned.id, amount:offer, buyerType:"Частник", negotiations:0};
  const result = game.acceptPendingSale(s, owned.id);
  assert.equal(result.ok, true);
  assert.equal(s.player.balance, before + offer);
  assert.equal(s.garage.some(x => x.id === owned.id), false);
  assert.equal(s.pendingDeal, null);
  assert.equal(s.transactions.filter(x => x.kind === "sale").length, 1);
  assert.equal(s.transactions[0].profit, 50000);
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


test("market events are deterministic and keep demand bounded", () => {
  const s = game.newState("market-event", "Tester");
  const seen = new Set();
  for (let turn = 0; turn < 30; turn++) {
    s.meta.turn = turn;
    game.refreshMarket(s);
    seen.add(s.meta.marketEvent.id);
    for (const car of s.market) {
      assert.ok(car.currentDemand >= 0.45 && car.currentDemand <= 0.98);
    }
  }
  assert.ok(seen.size >= 3);
});


test("vehicle repair cannot spend indefinitely after full restoration", () => {
  const s = game.newState("repair-test", "Tester");
  const car = s.market[0];
  car.damage = 1;
  car.condition = 99;
  const before = car.repairSpent || 0;
  car.repairSpent = before + 10000;
  car.damage = 0;
  car.condition = 100;
  assert.equal(car.damage, 0);
  assert.equal(car.condition, 100);
  assert.ok(car.repairSpent > before);
});

test("transaction ledger keeps vehicle and plate economics separate", () => {
  const s = game.newState("ledger-test", "Tester");
  game.addTx(s, "buy", -500000, "Покупка автомобиля");
  game.addTx(s, "repair", -50000, "Ремонт автомобиля");
  game.addTx(s, "prep", -20000, "Подготовка автомобиля");
  game.addTx(s, "sale", 700000, "Продажа автомобиля (прибыль 130000 ₽)");
  game.addTx(s, "plate_buy", -30000, "Покупка номера А123ВС 77");
  game.addTx(s, "plate_sale", 45000, "Продажа номера А123ВС 77");
  assert.equal(s.player.balance, 3145000);
  assert.equal(s.transactions.filter(x=>x.kind==="sale").length, 1);
  assert.equal(s.transactions.filter(x=>x.kind==="plate_sale").length, 1);
});


test("limited market listings have bounded lifetime and competition data", () => {
  const s = game.newState("live-market", "Tester");
  assert.ok(Number.isInteger(s.meta.competitors));
  assert.ok(s.meta.competitors >= 1 && s.meta.competitors <= 4);
  assert.ok(s.meta.competitionLevel >= 25 && s.meta.competitionLevel <= 95);
  for (const car of s.market) {
    assert.ok(car.expiresAtTurn > s.meta.turn);
    assert.ok(car.expiresAtTurn - s.meta.turn >= 5 && car.expiresAtTurn - s.meta.turn <= 9);
    assert.ok(car.competition >= 0.20 && car.competition <= 0.85);
    assert.ok(car.marketPressure >= 0.10 && car.marketPressure <= 0.95);
  }
});

test("expired listings are removed on market refresh", () => {
  const s = game.newState("market-expiry", "Tester");
  const expired = s.market[0];
  expired.expiresAtTurn = 0;
  s.meta.turn = 1;
  game.refreshMarket(s);
  assert.ok(!s.market.some(x => x.id === expired.id));
  assert.equal(s.market.length, 5);
});


test("vehicle cost basis includes diagnostics and prevents false profit", () => {
  const s = game.newState("cost-basis-player", "Tester");
  const car = {...s.market[0], repairSpent:40000, extraSpent:18000, diagnosticsSpent:35000};
  assert.equal(game.vehicleCost(car), car.buyPrice + 40000 + 18000 + 35000);
});

test("repair flow spends once and changes the real vehicle", () => {
  const s = game.newState("repair-flow", "Tester");
  const source = s.market[0];
  const car = {...source, status:"owned", damage:6, condition:82, repairSpent:0, extraSpent:0, diagnosticsSpent:0};
  s.garage.push(car);
  const before = s.player.balance;
  const beforeTx = s.transactions.length;
  const result = game.repairVehicle(s, car.id);
  assert.equal(result.ok, true);
  assert.ok(result.cost > 0);
  assert.equal(s.player.balance, before - result.cost);
  assert.equal(s.transactions.length, beforeTx + 1);
  assert.equal(s.transactions[0].kind, "repair");
  assert.ok(car.damage < 6);
  assert.ok(car.condition > 82);
  assert.equal(car.repairSpent, result.cost);
});

test("repair flow blocks a fully restored vehicle without spending", () => {
  const s = game.newState("repair-restored", "Tester");
  const car = {...s.market[0], status:"owned", damage:0, condition:100, repairSpent:25000};
  s.garage.push(car);
  const before = s.player.balance;
  const txBefore = s.transactions.length;
  const result = game.repairVehicle(s, car.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "restored");
  assert.equal(s.player.balance, before);
  assert.equal(s.transactions.length, txBefore);
});

test("preparation flow spends once and raises sale target", () => {
  const s = game.newState("prep-flow", "Tester");
  const source = s.market[0];
  const car = {...source, status:"owned", damage:3, condition:85, extraSpent:0, repairSpent:0, diagnosticsSpent:0};
  s.garage.push(car);
  const before = s.player.balance;
  const targetBefore = car.targetSale;
  const txBefore = s.transactions.length;
  const result = game.prepareVehicle(s, car.id);
  assert.equal(result.ok, true);
  assert.equal(s.player.balance, before - result.cost);
  assert.equal(s.transactions.length, txBefore + 1);
  assert.equal(s.transactions[0].kind, "prep");
  assert.equal(car.extraSpent, result.cost);
  assert.ok(car.condition > 85);
  assert.ok(car.targetSale > targetBefore);
});

test("vehicle purchase spends once and materializes hidden defects", () => {
  const s = game.newState("purchase-flow", "Tester");
  const car = s.market[0];
  car.hiddenDefects = 2;
  const before = s.player.balance;
  const result = game.purchaseListing(s, car.id);
  assert.equal(result.ok, true);
  assert.equal(s.player.balance, before - car.buyPrice);
  assert.equal(s.garage.length, 1);
  assert.equal(s.market.some(x => x.id === car.id), false);
  assert.equal(s.transactions.filter(x => x.kind === "buy").length, 1);
  assert.equal(result.car.hiddenDefects, 0);
  assert.ok(result.car.damage >= 2);
  assert.ok(result.car.condition <= 90);
});

test("expired vehicle purchase cannot spend money", () => {
  const s = game.newState("expired-purchase", "Tester");
  const car = s.market[0];
  car.expiresAtTurn = s.meta.turn;
  const before = s.player.balance;
  const result = game.purchaseListing(s, car.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");
  assert.equal(s.player.balance, before);
  assert.equal(s.garage.length, 0);
});

test("plate buy and sell flows change balance and inventory exactly once", () => {
  const s = game.newState("plate-trade-flow", "Tester");
  const plate = s.plateMarket[0];
  const beforeBuy = s.player.balance;
  const buy = game.buyPlate(s, plate.id);
  assert.equal(buy.ok, true);
  assert.equal(s.player.balance, beforeBuy - plate.buyPrice);
  assert.equal(s.plateWarehouse.length, 1);
  assert.equal(s.transactions.filter(x => x.kind === "plate_buy").length, 1);
  const ownedId = buy.plate.id;
  const beforeSell = s.player.balance;
  const sell = game.sellPlate(s, ownedId);
  assert.equal(sell.ok, true);
  assert.equal(s.player.balance, beforeSell + sell.offer);
  assert.equal(s.plateWarehouse.length, 0);
  assert.equal(s.transactions.filter(x => x.kind === "plate_sale").length, 1);
  assert.equal(sell.profit, sell.offer - plate.buyPrice);
});

test("vehicle diagnostics reveal and charge without changing purchase price", () => {
  const s = game.newState("diagnostics-player", "Tester");
  const car = s.market[0];
  const before = s.player.balance;
  const hiddenBefore = car.hiddenDefects;
  const result = game.runDiagnostic(s, car, false);
  assert.equal(result.ok, true);
  assert.equal(s.player.balance, before - 12000);
  assert.equal(car.diagnosticsSpent, 12000);
  assert.ok(car.hiddenDefects <= hiddenBefore);
});

test("deep diagnostics remove remaining hidden defects", () => {
  const s = game.newState("deep-diagnostics-player", "Tester");
  const car = s.market[0];
  const result = game.runDiagnostic(s, car, true);
  assert.equal(result.ok, true);
  assert.equal(s.player.balance, 3000000 - 35000);
  assert.equal(car.diagnosticLevel, 2);
  assert.equal(car.hiddenDefects, 0);
});

test("hidden defects increase real ownership risk when buying without full diagnosis", () => {
  const s = game.newState("hidden-defect-buy", "Tester");
  const car = s.market[0];
  car.hiddenDefects = 2;
  car.damage = 1;
  car.condition = 90;
  car.repairCost = 100000;
  const beforeRisk = car.risk;
  s.garage.push({...car, status:"owned"});
  const owned = s.garage[0];
  const hiddenPenalty = Math.min(3, Number(owned.hiddenDefects)||0);
  owned.damage = Math.min(10, (owned.damage||0) + hiddenPenalty);
  owned.condition = Math.max(55, (owned.condition||0) - hiddenPenalty*4);
  owned.repairCost = Math.round(owned.repairCost * (1 + hiddenPenalty*0.12));
  owned.risk = Math.min(0.8, owned.risk + hiddenPenalty*0.06);
  assert.ok(owned.damage > 1);
  assert.ok(owned.condition < 90);
  assert.ok(owned.repairCost > 100000);
  assert.ok(owned.risk > beforeRisk);
});

