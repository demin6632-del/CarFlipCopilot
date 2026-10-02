const assert=require("assert");
const economy=require("./game-economy");
assert.equal(typeof economy.recordTransition,"function");
assert.equal(typeof economy.summary,"function");
assert.equal(economy.classify({raw_message:"Продление объявления"},{},"Продлить"),"renewal");
assert.equal(economy.classify({raw_message:"Аукцион госномера"},{},"Ставка"),"plate");
assert.equal(economy.classify({raw_message:"Предложение покупателя"},{},"По рукам"),"sale");
console.log("GAME ECONOMY TESTS: PASS");
