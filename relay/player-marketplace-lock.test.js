"use strict";

const assert = require("node:assert/strict");
const game = require("./autonomous-game");

const state = {
  player: { balance: 1000000, respect: 0, level: 1, xp: 0 },
  garage: [{
    id: "car-1", model: "Lada Vesta 1.6", marketplaceListingId: "22222222-2222-5222-8222-222222222222",
    buyPrice: 500000, repairSpent: 0, extraSpent: 0, diagnosticsSpent: 0,
    damage: 2, condition: 90, repairCost: 30000, targetSale: 700000
  }],
  pendingDeal: { carId: "car-1", buyerType: "Частник", amount: 650000 },
  transactions: [],
  contracts: [],
  meta: { seed: 1, turn: 1 }
};

const balance = state.player.balance;
const sale = game.acceptPendingSale(state, "car-1");
assert.equal(sale.ok, false);
assert.equal(sale.reason, "listed");
assert.equal(state.garage.length, 1);
assert.equal(state.player.balance, balance);
assert.ok(state.pendingDeal, "pending deal is left untouched");

const repair = game.repairVehicle(state, "car-1");
assert.equal(repair.ok, false);
assert.equal(repair.reason, "listed");
assert.equal(state.player.balance, balance);

const prep = game.prepareVehicle(state, "car-1");
assert.equal(prep.ok, false);
assert.equal(prep.reason, "listed");
assert.equal(state.player.balance, balance);

console.log("PASS: listed vehicles cannot be sold, repaired, or prepared locally");
