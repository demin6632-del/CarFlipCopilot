const assert=require("assert");
const s=require("./strategy-engine");
assert.equal(s.actionType("Купить"),"buy");
assert.equal(s.actionType("Продлить объявление"),"renew");
assert.equal(s.actionType("По рукам"),"sell");
const c=s.parseContract("Контракт: производитель. Награда 200000 ₽. Максимум 2500000 ₽. Не менее 300 л.с.");
assert.equal(c.reward,200000);
assert.equal(c.maxPrice,2500000);
assert.equal(c.minHp,300);
const out=s.buildStrategy({
  raw_message:"Предложение покупателя 2 900 000 ₽",
  buttons:["По рукам","Продлить","Отмена"],
  vehicle:{name:"Audi A4"},
  offer:2900000
},[
  {label:"По рукам",percent:62},
  {label:"Продлить",percent:23},
  {label:"Отмена",percent:15}
],{
  transactions:[{action:"Продлить"},{action:"Продлить"}],
  vehicles:[{status:"active",full_cost:2821258}]
});
assert.equal(out.economics.delta,788742);
assert.equal(out.alternatives.length,3);
assert.ok(out.alternatives.find(x=>x.label==="Продлить").reasons.length>0);
console.log("STRATEGY ENGINE TESTS: PASS");
