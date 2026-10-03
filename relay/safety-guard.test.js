const assert=require("assert");
const {
  normalizeScreenText,normalizeButtons,screenFingerprint,isDuplicateScreen,
  classifyScreen,validateOcrState,chooseStableState
}=require("./safety-guard");

assert.equal(normalizeScreenText("  Баланс:\u00a0  5 000 000  \r\n\r\n\r\n"),"Баланс: 5 000 000");
assert.deepEqual(normalizeButtons([" Купить ","Купить","","Продать"]),["Купить","Продать"]);

const a=screenFingerprint("Баланс: 5 000 000",["Купить","Продать"]);
const b=screenFingerprint("Баланс: 5 000 000",["Купить","Продать"]);
assert.equal(a,b);
assert.equal(isDuplicateScreen({fingerprint:a,receivedAt:1000},{fingerprint:b,receivedAt:5000}),true);
assert.equal(classifyScreen("Предложение покупателя 2 800 000 ₽"),"buyer");
assert.equal(classifyScreen("Аукцион госномера"),"auction");
assert.equal(validateOcrState({balance:5000000,price:2800000}).valid,true);
assert.equal(validateOcrState({balance:5000,price:9000000}).valid,false);
const previous={balance:5000000};
const result=chooseStableState(previous,{balance:5000,price:9000000000});
assert.equal(result.accepted,false);
assert.deepEqual(result.state,previous);

console.log("SAFETY GUARD TESTS: PASS");
