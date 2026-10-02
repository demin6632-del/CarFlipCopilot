const assert=require("assert");
const s=require("./strategy-engine");
const nbsp=/\u00a0/g;
const ru=n=>String(n).replace(/\u00a0/g," ");

assert.equal(s.actionType("Купить"),"buy");
assert.equal(s.actionType("Продлить объявление"),"renew");
assert.equal(s.actionType("По рукам"),"sell");

const c=s.parseContract("Контракт: производитель. Награда 200000 ₽. Максимум 2500000 ₽. Не менее 300 л.с.");
assert.equal(c.reward,200000); assert.equal(c.maxPrice,2500000); assert.equal(c.minHp,300);

const out=s.buildStrategy({raw_message:"Предложение покупателя 2 900 000 ₽",buttons:["По рукам","Продлить","Отмена"],vehicle:{name:"Audi A4"},offer:2900000},
[{label:"По рукам",percent:62},{label:"Продлить",percent:23},{label:"Отмена",percent:15}],
{transactions:[{action:"Продлить"},{action:"Продлить"}],vehicles:[{status:"active",full_cost:2821258}]});
assert.equal(out.economics.delta,75742); assert.equal(out.alternatives.length,3);
assert.ok(out.alternatives.find(x=>x.label==="Продлить").reasons.length>0);
assert.ok(/1 500/.test(ru(out.alternatives.find(x=>x.label==="Продлить").scenario)));
assert.equal(out.renewalCount,2);

assert.ok(/1 500/.test(ru(s.scenarioFor("renew",{},null))));
const fit=s.contractFit({minHp:300,maxPrice:2500000},{vehicle:{hp:320},price:2400000});
assert.equal(fit.known,2); assert.equal(fit.passed,2); assert.equal(fit.satisfied,true);
const failedFit=s.contractFit({minHp:300,maxPrice:2500000},{vehicle:{hp:265},price:2900000});
assert.equal(failedFit.known,2); assert.equal(failedFit.passed,0); assert.equal(failedFit.failed,2);
assert.equal(failedFit.complete,true); assert.equal(failedFit.satisfied,false);

assert.equal(ru(s.scenarioFor("buy",{balance:5000000,price:2000000})), "Покупка: −2 000 000 ₽; остаток ≈ 3 000 000 ₽.");
assert.ok(/не подтверждено/i.test(s.scenarioFor("other",{},null)));
for(const label of ["Продать","Продлить","Номер","Ремонт","Тюнинг","Работа","Отмена"]) assert.ok(s.actionType(label));

const generic=s.buildStrategy({raw_text:"Баланс: 5 990 655 ₽\nГараж: 1/3",buttons:["Профиль","Гараж","Настройки"]},
[{label:"Профиль",percent:50},{label:"Гараж",percent:30},{label:"Настройки",percent:20}],{transactions:[],vehicles:[]});
assert.equal(generic.actionable,false); assert.equal(s.actionType("Гараж"),"other");

const explicit=s.buildStrategy({raw_text:"Нажми «Продлить объявление»",buttons:["Продлить объявление","Отмена"]},
[{label:"Продлить объявление",percent:70},{label:"Отмена",percent:30}],{transactions:[],vehicles:[]});
assert.equal(explicit.actionable,true); assert.equal(explicit.actionEvidence,"Продлить объявление");

const purchase=s.buildStrategy({raw_text:"Автомобиль Audi A4\nЦена: 2 000 000 ₽\nКупить",contexts:{purchaseContext:true},balance:5000000,price:2000000,buttons:["Купить","Отмена"]},
[{label:"Купить",percent:70},{label:"Отмена",percent:30}],{transactions:[],vehicles:[]});
assert.equal(purchase.actionable,true); assert.equal(purchase.alternatives.find(x=>x.label==="Купить").type,"buy");
assert.ok(/остаток/.test(purchase.alternatives.find(x=>x.label==="Купить").scenario));

const buyer=s.buildStrategy({raw_text:"Покупатель предлагает 2 900 000 ₽\nПо рукам",contexts:{buyerContext:true},buttons:["По рукам","Продлить","Отмена"]},
[{label:"По рукам",percent:70},{label:"Продлить",percent:20},{label:"Отмена",percent:10}],{transactions:[],vehicles:[{status:"active",full_cost:2821258}]});
assert.equal(buyer.actionable,true); assert.equal(buyer.alternatives.find(x=>x.label==="По рукам").type,"sell");
assert.ok(/78 742/.test(ru(buyer.alternatives.find(x=>x.label==="По рукам").scenario)));
assert.equal(buyer.economics.offer,2900000);

const plate=s.buildStrategy({raw_text:"Аукцион госномера\nСтавка 400 000 ₽",contexts:{explicitPlateAuction:true},buttons:["Сделать ставку","Отмена"]},
[{label:"Сделать ставку",percent:60},{label:"Отмена",percent:40}],{transactions:[],vehicles:[]});
assert.equal(plate.actionable,true); assert.equal(plate.alternatives.find(x=>x.label==="Сделать ставку").type,"plate");
assert.ok(/10%/.test(plate.alternatives.find(x=>x.label==="Сделать ставку").scenario));

const contract=s.buildStrategy({raw_text:"Контракт: минимум 300 л.с., максимум 2 500 000 ₽",contexts:{dealContext:true},vehicle:{hp:265},price:2900000,buttons:["Выполнить контракт","Отмена"]},
[{label:"Выполнить контракт",percent:80},{label:"Отмена",percent:20}],{transactions:[],vehicles:[]});
assert.equal(contract.contractFit.failed,2); assert.equal(contract.alternatives.find(x=>x.label==="Выполнить контракт").contractBlocked,true);
assert.ok(contract.warnings.some(x=>/условия контракта/.test(x)));
console.log("STRATEGY ENGINE TESTS: PASS");