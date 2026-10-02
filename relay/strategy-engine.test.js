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
assert.equal(out.economics.delta,78742);
assert.equal(out.alternatives.length,3);
assert.ok(out.alternatives.find(x=>x.label==="Продлить").reasons.length>0);
const renew=s.scenarioFor("renew",{},null);
assert.ok(/себестоимост/i.test(renew));
const fit=s.contractFit({minHp:300,maxPrice:2500000},{vehicle:{hp:320},price:2400000});
assert.equal(fit.known,2);
assert.equal(fit.passed,2);
assert.equal(s.scenarioFor("buy",{},null),"Покупка: деньги уйдут сразу; прибыль не фиксируется до будущей продажи.");
assert.ok(/не подтверждено/i.test(s.scenarioFor("other",{},null)));
const cases=["Продать","Продлить","Номер","Ремонт","Тюнинг","Работа","Отмена"];
for(const label of cases) assert.ok(s.actionType(label));
const failedFit=s.contractFit({minHp:300,maxPrice:2500000},{vehicle:{hp:265},price:2900000});
assert.equal(failedFit.known,2);
assert.equal(failedFit.passed,0);

console.log("STRATEGY ENGINE TESTS: PASS");

const generic=s.buildStrategy({raw_text:"Баланс: 5 990 655 ₽\nГараж: 1/3",buttons:["Профиль","Гараж","Настройки"]},[
  {label:"Профиль",percent:50},{label:"Гараж",percent:30},{label:"Настройки",percent:20}
],{transactions:[],vehicles:[]});
assert.equal(generic.actionable,false);
assert.equal(s.actionType("Гараж"),"other");
const explicit=s.buildStrategy({raw_text:"Нажми «Продлить объявление»",buttons:["Продлить объявление","Отмена"]},[
  {label:"Продлить объявление",percent:70},{label:"Отмена",percent:30}
],{transactions:[],vehicles:[]});
assert.equal(explicit.actionable,true);
assert.equal(explicit.actionEvidence,"Продлить объявление");

const purchase=s.buildStrategy({raw_text:"Автомобиль Audi A4\nЦена: 2 000 000 ₽\nКупить",contexts:{purchaseContext:true},buttons:["Купить","Отмена"]},[
  {label:"Купить",percent:70},{label:"Отмена",percent:30}
],{transactions:[],vehicles:[]});
assert.equal(purchase.actionable,true);
assert.equal(purchase.alternatives.find(x=>x.label==="Купить").type,"buy");

const buyer=s.buildStrategy({raw_text:"Покупатель предлагает 2 900 000 ₽\nПо рукам",contexts:{buyerContext:true},buttons:["По рукам","Продлить","Отмена"]},[
  {label:"По рукам",percent:70},{label:"Продлить",percent:20},{label:"Отмена",percent:10}
],{transactions:[],vehicles:[{status:"active",full_cost:2821258}]});
assert.equal(buyer.actionable,true);
assert.equal(buyer.alternatives.find(x=>x.label==="По рукам").type,"sell");

const plate=s.buildStrategy({raw_text:"Аукцион госномера\nСтавка 400 000 ₽",contexts:{explicitPlateAuction:true},buttons:["Сделать ставку","Отмена"]},[
  {label:"Сделать ставку",percent:60},{label:"Отмена",percent:40}
],{transactions:[],vehicles:[]});
assert.equal(plate.actionable,true);
assert.equal(plate.alternatives.find(x=>x.label==="Сделать ставку").type,"plate");
