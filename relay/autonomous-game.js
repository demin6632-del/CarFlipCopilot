const { Pool } = require("pg");

const VERSION = 2;
const START_BALANCE = 3000000;
const GARAGE_CAPACITY = 3;

const CATALOG = [
  { id:"vesta_2019", name:"Lada Vesta 1.6", year:2019, base:720000, demand:0.92, risk:0.12, repair:42000, sale:910000 },
  { id:"focus_2017", name:"Ford Focus 1.6", year:2017, base:890000, demand:0.78, risk:0.18, repair:68000, sale:1120000 },
  { id:"octavia_2018", name:"Skoda Octavia 1.4", year:2018, base:1180000, demand:0.84, risk:0.16, repair:79000, sale:1450000 },
  { id:"camry_2015", name:"Toyota Camry 2.5", year:2015, base:1540000, demand:0.88, risk:0.14, repair:96000, sale:1830000 },
  { id:"mazda6_2017", name:"Mazda 6 2.0", year:2017, base:1360000, demand:0.81, risk:0.21, repair:112000, sale:1690000 },
  { id:"a4_2016", name:"Audi A4 1.8", year:2016, base:1490000, demand:0.73, risk:0.29, repair:154000, sale:1900000 },
  { id:"x1_2015", name:"BMW X1 2.0", year:2015, base:1710000, demand:0.69, risk:0.34, repair:185000, sale:2190000 },
  { id:"qashqai_2018", name:"Nissan Qashqai 2.0", year:2018, base:1260000, demand:0.86, risk:0.17, repair:72000, sale:1540000 }
];

let poolPromise = null;
function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = Promise.resolve(new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized:false },
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 7000,
      statement_timeout: 7000
    }));
  }
  return poolPromise;
}

async function init() {
  const p = db(); if (!p) return false;
  const pool = await p;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autonomous_game_state (
      chat_id text PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS autonomous_game_state_updated_idx
      ON autonomous_game_state(updated_at DESC);
  `);
  return true;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }
function money(n){ return Math.round(Number(n)||0); }
function fmt(n){ return money(n).toLocaleString("ru-RU")+" ₽"; }
function vehicleCost(c){ return money((c?.buyPrice||0)+(c?.repairSpent||0)+(c?.extraSpent||0)+(c?.diagnosticsSpent||0)); }

function seedFor(chat) {
  let h=2166136261;
  for(const c of String(chat)) { h^=c.charCodeAt(0); h=Math.imul(h,16777619); }
  return (h>>>0);
}
function rng(state) {
  state.meta.seed = (Math.imul(Number(state.meta.seed)||1,1664525)+1013904223)>>>0;
  return state.meta.seed/4294967296;
}
function createListing(state) {
  const base = CATALOG[Math.floor(rng(state)*CATALOG.length)];
  const condition = 0.78 + rng(state)*0.20;
  const mileage = Math.round((45000+rng(state)*155000)/1000)*1000;
  const market = base.base*(0.90+rng(state)*0.17);
  const buy = Math.round((market*(0.80+rng(state)*0.10))/1000)*1000;
  const damage = Math.max(0,Math.round((1-condition)*7));
  const listingSeq = (Number(state.meta.listingSeq)||0) + 1;
  state.meta.listingSeq = listingSeq;
  const id = "car_"+String(state.meta.turn||0)+"_"+listingSeq;
  return {
    id, model:base.name, catalogId:base.id, year:base.year, mileage,
    buyPrice:Math.max(50000,buy), marketPrice:Math.round(market),
    repairCost:Math.round(base.repair*(0.65+rng(state)*0.7)),
    targetSale:Math.round(base.sale*(0.93+rng(state)*0.12)),
    demand:base.demand, risk:Math.min(0.8,base.risk+damage*0.025),
    condition:Math.round(condition*100), damage, status:"market",
    generatedAt:Date.now(),
    expiresAtTurn:(Number(state.meta.turn)||0) + 5 + Math.floor(rng(state)*5),
    limited: rng(state) > 0.72,
    competition: 0.20 + rng(state)*0.65,
    hiddenDefects: Math.max(0, Math.min(2, Math.floor((base.risk + rng(state)*0.30) * 2))),
    diagnosticLevel: 0,
    diagnosticsSpent: 0,
    hiddenDefectSeverity: 0
  };
}
function plateCode(state) {
  const letters = "АВЕКМНОРСТУХ";
  const nums = String(100 + Math.floor(rng(state)*900));
  const region = String(1 + Math.floor(rng(state)*199)).padStart(2,"0");
  return letters[Math.floor(rng(state)*letters.length)] + nums + letters[Math.floor(rng(state)*letters.length)] + letters[Math.floor(rng(state)*letters.length)] + " " + region;
}
function createPlateListing(state) {
  const quality = 55 + Math.floor(rng(state)*46);
  const rarity = 0.7 + rng(state)*1.5;
  const base = Math.round((12000 + quality*850 + rarity*18000)/1000)*1000;
  return {
    id:(() => { const seq=(Number(state.meta.plateSeq)||0)+1; state.meta.plateSeq=seq; return "plate_"+String(state.meta.turn||0)+"_"+seq; })(),
    plate:plateCode(state),
    quality, rarity:Math.round(rarity*100)/100,
    buyPrice:base,
    status:"auction",
    generatedAt:Date.now()
  };
}
function refreshPlates(state) {
  const cycle = Math.floor((Number(state.meta.turn)||0) / 4);
  state.meta.plateCycle = cycle;
  while(state.plateMarket.length < 3) state.plateMarket.push(createPlateListing(state));
  return state.plateMarket;
}
function refreshMarket(state) {
  const cycle = Math.floor((Number(state.meta.turn)||0) / 5);
  state.meta.marketCycle = cycle;
  const events = [
    {id:"steady",title:"Спокойный рынок",delta:0,text:"Цены без резких изменений."},
    {id:"family",title:"Семейный спрос",delta:0.06,text:"Спрос на практичные автомобили вырос."},
    {id:"repair",title:"Дефицит сервиса",delta:-0.04,text:"Подготовка машин стала менее выгодной."},
    {id:"sedan",title:"Спрос на седаны",delta:0.08,text:"Покупатели активнее ищут седаны."},
    {id:"crossover",title:"Неделя кроссоверов",delta:0.08,text:"Кроссоверы уходят быстрее обычного."}
  ];
  state.meta.marketEvent = events[cycle % events.length];
  state.meta.competitors = 1 + Math.floor(rng(state)*4);
  state.meta.competitionLevel = Math.round((0.25 + rng(state)*0.70)*100);
  const turn = Number(state.meta.turn)||0;
  state.market = state.market.filter(car => car.expiresAtTurn == null || car.expiresAtTurn > turn);
  while(state.market.length<5) state.market.push(createListing(state));
  for(const car of state.market) {
    const wave = Math.sin((cycle + car.catalogId.length) * 0.9) * 0.06;
    const eventDelta = state.meta.marketEvent?.delta || 0;
    const modelBonus = state.meta.marketEvent?.id==="crossover" && /Qashqai|X1/.test(car.model) ? 0.06 : 0;
    const sedanBonus = state.meta.marketEvent?.id==="sedan" && /Vesta|Focus|Octavia|Camry|Mazda|Audi/.test(car.model) ? 0.05 : 0;
    const competitionPenalty = (state.meta.competitionLevel||0) > 75 ? 0.025 : 0;
    car.currentDemand = Math.max(0.45, Math.min(0.98, car.demand + wave + eventDelta + modelBonus + sedanBonus - competitionPenalty));
    car.marketPressure = Math.max(0.10, Math.min(0.95, car.competition + (state.meta.competitionLevel||50)/200));
  }
  return state.market;
}
const BUYER_TYPES = [
  {id:"reseller",title:"Перекупщик",base:0.93,condition:0.03,demand:0.03,patience:0.72},
  {id:"private",title:"Частник",base:0.98,condition:0.09,demand:0.02,patience:0.58},
  {id:"family",title:"Семья",base:0.97,condition:0.05,demand:0.08,patience:0.64},
  {id:"enthusiast",title:"Энтузиаст",base:1.00,condition:0.12,demand:0.04,patience:0.46}
];

function buyerProfile(state, car) {
  const idx = Math.floor(rng(state) * BUYER_TYPES.length);
  const type = BUYER_TYPES[idx];
  const reputation = Math.max(0, Math.min(50, Number(state.player.respect)||0));
  const demand = Math.max(0.45, Math.min(0.98, car.currentDemand ?? car.demand));
  const condition = Math.max(0, Math.min(100, Number(car.condition)||0));
  const demandFactor = 0.94 + demand * type.demand;
  const conditionFactor = 0.94 + (condition / 100) * type.condition;
  const reputationFactor = 1 + reputation * 0.0015;
  const noise = 0.985 + rng(state) * 0.03;
  const amount = Math.max(1000, Math.round((car.targetSale * type.base * demandFactor * conditionFactor * reputationFactor * noise) / 1000) * 1000);
  return {
    typeId:type.id,
    buyerType:type.title,
    patience:type.patience,
    amount,
    demand:Math.round(demand*100),
    condition,
    reputation,
    reason: type.id==="reseller" ? "Считает будущую перепродажу и жёстко торгуется."
      : type.id==="private" ? "Сильнее всего смотрит на состояние и отсутствие вложений."
      : type.id==="family" ? "Ищет практичную машину и реагирует на текущий спрос."
      : "Готов платить за хорошее состояние, но придирчив к дефектам."
  };
}

function buyerOfferDetails(state, car) {
  return buyerProfile(state, car);
}

function buyerOffer(state, car) {
  return buyerOfferDetails(state, car).amount;
}

function negotiation(state, car, deal) {
  const profile = BUYER_TYPES.find(x=>x.id===deal.typeId) || BUYER_TYPES[0];
  if ((Number(deal.negotiations)||0) >= 1) {
    return {accepted:false,left:false,amount:deal.amount,text:"Покупатель уже сделал финальное предложение."};
  }
  const condition = Math.max(0, Math.min(100, Number(car.condition)||0));
  const demand = Math.max(0.45, Math.min(0.98, car.currentDemand ?? car.demand));
  const leverage = 0.015 + (condition/100)*0.025 + demand*0.012 + Math.min(50, Number(state.player.respect)||0)*0.0004;
  const raise = Math.round((deal.amount * Math.min(0.06, leverage)) / 1000) * 1000;
  const leaveChance = Math.max(0.04, Math.min(0.34, 0.30 - profile.patience + (1-condition/100)*0.12));
  if (rng(state) < leaveChance) {
    return {accepted:false,left:true,amount:deal.amount,text:"Покупатель не согласился продолжать торг."};
  }
  return {accepted:true,left:false,amount:deal.amount+raise,text:"Покупатель немного поднял цену после торга."};
}
function dealRisk(state, car) {
  const risk = Math.max(0, Math.min(0.8, car.risk - car.condition / 1000));
  const roll = rng(state);
  if (roll < risk * 0.18) {
    const penalty = Math.round((9000 + rng(state) * 36000) / 1000) * 1000;
    return {type:"incident", penalty, text:"Покупатель заметил дополнительный дефект."};
  }
  if (roll > 0.94 && (car.currentDemand ?? car.demand) > 0.82) {
    const bonus = Math.round((12000 + rng(state) * 30000) / 1000) * 1000;
    return {type:"bonus", bonus, text:"Спрос на эту модель вырос, покупатель поднял предложение."};
  }
  return {type:"normal"};
}
function newState(chat, firstName) {
  const state = {
    version:VERSION,
    player:{name:String(firstName||"Перекуп"),level:1,xp:0,respect:0,balance:START_BALANCE,garageCapacity:GARAGE_CAPACITY},
    garage:[],
    market:[],
    transactions:[],
    plates:[],
    contracts:[
      {id:"profit_300k",title:"Первая крупная сделка",goal:"Получи 300 000 ₽ совокупной прибыли",target:300000,progress:0,reward:150000,completed:false},
      {id:"two_sales",title:"Две сделки",goal:"Продай 2 автомобиля с прибылью",target:2,progress:0,reward:180000,completed:false},
      {id:"respect_10",title:"Имя на рынке",goal:"Набери 10 репутации",target:10,progress:0,reward:220000,completed:false}
    ],
    plateMarket:[],
    plateWarehouse:[],
    meta:{seed:seedFor(chat),turn:0,createdAt:Date.now(),day:1,plateCycle:0},
    lastAction:null,
    pendingDeal:null,
    pendingPurchase:null,
    processedCallbacks:[]
  };
  refreshMarket(state);
  refreshPlates(state);
  return state;
}
async function load(chat, firstName) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const r=await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1",[String(chat)]);
  if(r.rowCount) {
    const state=r.rows[0].state;
    state.plateMarket=state.plateMarket||[];
    state.plateWarehouse=state.plateWarehouse||[];
    state.contracts=state.contracts||[];
    if(!state.meta) state.meta={seed:seedFor(chat),turn:0,createdAt:Date.now(),day:1,plateCycle:0};
    state.meta.day=state.meta.day||1;
    state.processedCallbacks=Array.isArray(state.processedCallbacks)?state.processedCallbacks:[];
    state.pendingDeal=state.pendingDeal||null;
    state.pendingPurchase=state.pendingPurchase||null;
    refreshPlates(state);
    return state;
  }
  const state=newState(chat,firstName);
  await pool.query(
    "INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,$2,$3::jsonb) ON CONFLICT(chat_id) DO NOTHING",
    [String(chat),VERSION,JSON.stringify(state)]
  );
  const again=await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1",[String(chat)]);
  return again.rows[0].state;
}
async function save(chat,state) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  await pool.query(
    "UPDATE autonomous_game_state SET version=$2,state=$3::jsonb,updated_at=now() WHERE chat_id=$1",
    [String(chat),VERSION,JSON.stringify(state)]
  );
}
async function withState(chat, firstName, mutate, callbackId) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const r=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    let state;
    if(r.rowCount) state=r.rows[0].state;
    else {
      state=newState(chat,firstName);
      await client.query("INSERT INTO autonomous_game_state(chat_id,version,state) VALUES($1,$2,$3::jsonb)",[String(chat),VERSION,JSON.stringify(state)]);
    }
    state.processedCallbacks=Array.isArray(state.processedCallbacks)?state.processedCallbacks:[];
    state.meta=state.meta||{seed:seedFor(chat),turn:0,createdAt:Date.now(),day:1,plateCycle:0};
    if(callbackId && state.processedCallbacks.includes(String(callbackId))) {
      await client.query("ROLLBACK");
      return {state,result:{duplicate:true}};
    }
    const result=await mutate(state);
    await client.query("UPDATE autonomous_game_state SET version=$2,state=$3::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),VERSION,JSON.stringify(state)]);
    await client.query("COMMIT");
    return {state,result};
  } catch(e) {
    await client.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally { client.release(); }
}

function addTx(state,kind,amount,description) {
  const delta=money(amount);
  state.player.balance+=delta;
  state.transactions.unshift({time:Date.now(),kind,amount:delta,balance:state.player.balance,description,profit:kind==="sale" ? Number((String(description).match(/прибыль ([\d\s]+) ₽/)||[])[1]?.replace(/\s/g,"")||0) : 0});
  state.transactions=state.transactions.slice(0,80);
}
function scoreListing(car) {
  const margin=car.targetSale-car.buyPrice-car.repairCost;
  return margin/car.buyPrice*100*car.demand*(1-car.risk);
}
function bestDeal(state) {
  return [...state.market].sort((a,b)=>scoreListing(b)-scoreListing(a))[0]||null;
}
function updateContracts(state, profit) {
  const profitableSales = state.transactions.filter(x=>x.kind==="sale").length;
  const totalProfit = state.transactions
    .filter(x=>x.kind==="sale")
    .reduce((sum,x)=>sum + Number(x.profit||0),0);
  for (const c of state.contracts) {
    if (c.id==="profit_300k") c.progress=Math.max(c.progress||0,totalProfit);
    if (c.id==="two_sales") c.progress=profitableSales;
    if (c.id==="respect_10") c.progress=state.player.respect;
    if (!c.completed && (
      (c.id==="profit_300k" && c.progress>=c.target) ||
      (c.id==="two_sales" && c.progress>=c.target) ||
      (c.id==="respect_10" && c.progress>=c.target)
    )) {
      c.completed=true;
      addTx(state,"contract",c.reward,"Награда: "+c.title);
    }
  }
}
function recommendation(state) {
  const car=bestDeal(state);
  if(!car) return {title:"Рынок пуст",text:"Обнови рынок.",car:null};
  const margin=car.targetSale-car.buyPrice-car.repairCost;
  const roi=margin/car.buyPrice*100;
  if(margin<=0) return {title:"Покупку пропустить",text:"У текущего лота отрицательная ожидаемая маржа.",car};
  if(car.risk>0.30) return {title:"Осторожно",text:"Маржа есть, но риск ремонта выше обычного.",car};
  return {title:"Лучший ход",text:"Этот лот даёт наиболее сильное сочетание маржи, спроса и риска.",car,roi};
}

function mainText(state) {
  const p=state.player;
  const event=state.meta.marketEvent||{title:"Спокойный рынок",text:"Стабильный спрос."};
  const deals=state.transactions.filter(x=>x.kind==="sale").length;
  return [
    "🚗 СИМУЛЯТОР ПЕРЕКУПА · V2",
    "",
    "👤 "+p.name+" · Ур. "+p.level+" · ⭐ "+p.respect,
    "💰 "+fmt(p.balance)+" · 🚘 "+state.garage.length+"/"+p.garageCapacity,
    "📅 День "+(state.meta.day||1)+" · Продаж: "+deals,
    "",
    "📈 "+event.title,
    event.text,
    "👥 Конкуренты: "+(state.meta.competitors||1)+" · давление "+(state.meta.competitionLevel||0)+"%",
    "",
    "Цель дня: найти недооценённую машину,",
    "проверить её, сторговаться, вложиться",
    "только там, где это окупается, и продать.",
    "",
    "Решение всегда остаётся за тобой."
  ].join("\n");
}
function menu() {
  return {inline_keyboard:[
    [{text:"🚗 Рынок",callback_data:"ag:market"},{text:"🏠 Гараж",callback_data:"ag:garage"}],
    [{text:"📅 Сегодня",callback_data:"ag:day"},{text:"📋 Контракты",callback_data:"ag:contracts"}],
    [{text:"🔢 Номера",callback_data:"ag:plates"},{text:"📊 Статистика",callback_data:"ag:stats"}]
  ]};
}
function marketKeyboard(state) {
  const turn=Number(state.meta.turn)||0;
  return {inline_keyboard:[
    ...state.market.slice(0,5).map((car,i)=>{
      const left=car.expiresAtTurn ? Math.max(0,car.expiresAtTurn-turn) : 0;
      const tag=car.limited ? "🔥 " : "";
      const margin=car.targetSale-car.buyPrice-car.repairCost;
      const signal=margin>150000 ? "💎" : margin>50000 ? "🟢" : margin>0 ? "🟡" : "🔴";
      return [{text:tag+(i+1)+". "+signal+" "+car.model+" · "+fmt(car.buyPrice)+(car.expiresAtTurn?" · ⏳"+left:""),callback_data:"ag:inspect:"+car.id}];
    }),
    [{text:"🔄 Обновить рынок",callback_data:"ag:refresh"}],
    [{text:"⬅️ Меню",callback_data:"ag:home"}]
  ]};
}
function garageKeyboard(state) {
  return {inline_keyboard:[
    ...state.garage.map((c,i)=>[{text:"🚘 "+(i+1)+". "+c.model,callback_data:"ag:car:"+c.id}]),
    [{text:"🚗 Рынок",callback_data:"ag:market"},{text:"⬅️ Меню",callback_data:"ag:home"}]
  ]};
}
function hiddenDefectLabel(c) {
  const count = Number(c.hiddenDefects)||0;
  const revealed = Number(c.diagnosticLevel)||0;
  if (!count) return "✅ Скрытых дефектов не выявлено.";
  if (revealed >= 2) return "🔬 Глубокая диагностика: скрытых дефектов не осталось.";
  if (revealed >= 1) return "🔎 Быстрая диагностика: часть скрытых дефектов проверена.";
  return "❓ Скрытые дефекты: неизвестно.";
}
function diagnosticCost(c, deep) {
  return deep ? 35000 : 12000;
}
function runDiagnostic(state, c, deep) {
  const cost = diagnosticCost(c, deep);
  if (state.player.balance < cost) return {ok:false,cost};
  addTx(state, "diagnostic", -cost, (deep ? "Глубокая диагностика " : "Быстрая диагностика ") + c.model);
  c.diagnosticsSpent = (c.diagnosticsSpent||0) + cost;
  if (deep) {
    c.diagnosticLevel = 2;
    c.hiddenDefects = 0;
    c.hiddenDefectSeverity = 0;
    return {ok:true,cost,found:0,deep:true};
  }
  c.diagnosticLevel = Math.max(1, c.diagnosticLevel||0);
  const found = Number(c.hiddenDefects)||0;
  if (found > 0) {
    c.hiddenDefects = Math.max(0, found - 1);
    c.hiddenDefectSeverity = Math.max(0, (c.hiddenDefectSeverity||0) - 1);
  }
  return {ok:true,cost,found:found>0?1:0,deep:false};
}
function revealRiskText(c) {
  if ((c.diagnosticLevel||0) >= 2) return "🔬 Диагностика: полная";
  if ((c.diagnosticLevel||0) >= 1) return "🔎 Диагностика: базовая";
  return "🔎 Диагностика: не проводилась";
}

function inspectText(c,state) {
  const margin=c.targetSale-c.buyPrice-c.repairCost;
  const marketGap=c.marketPrice-c.buyPrice;
  const low=Math.max(0,Math.round((margin*0.55)/1000)*1000);
  const high=Math.max(0,Math.round((margin*1.05)/1000)*1000);
  return [
    "🔎 ОСМОТР ЛОТА",
    "",
    "🚘 "+c.model+" · "+c.year,
    "🛣 "+c.mileage.toLocaleString("ru-RU")+" км · состояние "+c.condition+"%",
    "⚠️ Повреждений: "+c.damage+" · риск "+Math.round(c.risk*100)+"%",
    "💵 Цена продавца: "+fmt(c.buyPrice),
    "📊 Рынок: "+fmt(c.marketPrice),
    "🔧 Оценка ремонта: "+fmt(c.repairCost),
    "🎯 Ориентир продажи: "+fmt(c.targetSale),
    "📈 Разница с рынком: "+fmt(marketGap),
    "💰 Расчётная прибыль: "+fmt(margin),
    "🎲 Реалистичный диапазон: "+fmt(low)+" — "+fmt(high),
    "📊 Спрос: "+Math.round((c.currentDemand??c.demand)*100)+"%",
    revealRiskText(c),
    hiddenDefectLabel(c),
    c.limited ? "🔥 Срочный лот — времени мало." : "📦 Обычный лот.",
    c.expiresAtTurn ? "⏳ До ухода с рынка: "+Math.max(0,c.expiresAtTurn-(Number(state.meta.turn)||0))+" ход." : ""
  ].join("\n");
}
function purchaseOfferText(state,c) {
  const p=state.pendingPurchase;
  return [
    "💬 ТОРГ С ПРОДАВЦОМ",
    "",
    "🚘 "+c.model,
    "💵 Цена продавца: "+fmt(c.buyPrice),
    "🤝 Твоё предложение: "+fmt(p.offer),
    p.result==="accepted" ? "✅ Продавец согласился." :
      p.result==="counter" ? "↔️ Продавец сделал встречное предложение: "+fmt(p.counter) :
      "⏳ Предложение отправлено.",
    "",
    "⚠️ После покупки неизвестные дефекты всё ещё могут увеличить расходы."
  ].join("\n");
}
function inspectKeyboard(c, state) {
  const free=state.garage.length<state.player.garageCapacity;
  return {inline_keyboard:[
    [{text:"🔎 Быстрая диагностика · 12 000 ₽",callback_data:"ag:diagnose:"+c.id}],
    [{text:"🔬 Глубокая диагностика · 35 000 ₽",callback_data:"ag:diagnose_deep:"+c.id}],
    ...(free ? [
      [{text:"💬 Торговаться",callback_data:"ag:offer:"+c.id}],
      [{text:"💳 Купить за "+fmt(c.buyPrice),callback_data:"ag:buy:"+c.id}]
    ] : []),
    [{text:"⬅️ Рынок",callback_data:"ag:market"}]
  ]};
}
function carText(c) {
  const cost=vehicleCost(c);
  const margin=c.targetSale-cost;
  return [
    "🚘 "+c.model,
    "",
    "💵 Себестоимость: "+fmt(cost),
    "🔧 Ремонт: "+fmt(c.repairSpent||0),
    "✨ Подготовка: "+fmt(c.extraSpent||0),
    "🔎 Диагностика: "+fmt(c.diagnosticsSpent||0),
    "🎯 Ориентир продажи: "+fmt(c.targetSale),
    "📈 Результат до продажи: "+fmt(margin)
  ].join("\n");
}
function carKeyboard(c) {
  return {inline_keyboard:[
    [{text:"🔧 Ремонт",callback_data:"ag:repair:"+c.id},{text:"✨ Подготовить",callback_data:"ag:prep:"+c.id}],
    [{text:"💰 Продать",callback_data:"ag:sell:"+c.id}],
    [{text:"⬅️ Гараж",callback_data:"ag:garage"}]
  ]};
}
function dealText(state, c, deal) {
  const cost=vehicleCost(c);
  const profit=deal.amount-cost;
  return [
    "🤝 ПРЕДЛОЖЕНИЕ ПОКУПАТЕЛЯ","",
    "👤 Покупатель: "+deal.buyerType,
    "💬 "+deal.reason,
    "💵 Предложение: "+fmt(deal.amount),
    "💼 Себестоимость: "+fmt(cost),
    "📈 Результат: "+fmt(profit),
    "📊 Спрос: "+deal.demand+"%",
    "⭐ Репутация учтена: "+deal.reputation,
    "",
    profit>=0 ? "Предложение не фиксирует убыток." : "Предложение ниже себестоимости — продажа заблокирована."
  ].join("\n");
}
function dealKeyboard(c, deal) {
  return {inline_keyboard:[
    [{text:"✅ Принять · "+fmt(deal.amount),callback_data:"ag:accept:"+c.id}],
    [{text:"💬 Торговаться",callback_data:"ag:negotiate:"+c.id}],
    [{text:"❌ Отказаться",callback_data:"ag:reject:"+c.id}],
    [{text:"⬅️ Машина",callback_data:"ag:car:"+c.id}]
  ]};
}
function addProgress(state, profit) {
  const gainedXp = Math.max(10, Math.min(250, Math.round(30 + Math.max(0, profit) / 15000)));
  state.player.xp += gainedXp;
  let levelUps = 0;
  while (state.player.xp >= state.player.level * 250) {
    state.player.xp -= state.player.level * 250;
    state.player.level += 1;
    levelUps += 1;
  }
  return { gainedXp, levelUps };
}
function statsText(state) {
  const tx=state.transactions;
  const income=tx.filter(x=>x.amount>0).reduce((s,x)=>s+x.amount,0);
  const spent=tx.filter(x=>x.amount<0).reduce((s,x)=>s-x.amount,0);
  const deals=tx.filter(x=>x.kind==="sale").length;
  const saleRevenue=tx.filter(x=>x.kind==="sale"||x.kind==="plate_sale").reduce((s,x)=>s+x.amount,0);
  const vehicleSpent=tx.filter(x=>x.kind==="buy"||x.kind==="repair"||x.kind==="prep"||x.kind==="diagnostic").reduce((s,x)=>s-x.amount,0);
  const plateSpent=tx.filter(x=>x.kind==="plate_buy").reduce((s,x)=>s-x.amount,0);
  const profit=saleRevenue-vehicleSpent-plateSpent;
  return ["📊 СТАТИСТИКА","","💰 Баланс: "+fmt(state.player.balance),"📥 Оборот входящих: "+fmt(income),"📤 Расходы: "+fmt(spent),"🤝 Продаж: "+deals,"📈 Валовой результат сделок: "+fmt(profit),"🔄 Ходов: "+state.meta.turn].join("\n");
}

function negotiatePurchase(state,id) {
  const c=state.market.find(x=>x.id===id);
  if(!c)return {ok:false,reason:"missing"};
  const offer=Math.max(1000,Math.round((c.buyPrice*(0.94+rng(state)*0.025))/1000)*1000);
  const pressure=Math.max(0.05,Math.min(0.75,(c.marketPressure||0.5)*0.55));
  const roll=rng(state);
  if(roll > pressure) {
    state.pendingPurchase={carId:id,offer,result:"accepted",finalPrice:offer};
    return {ok:true,result:"accepted",offer,finalPrice:offer};
  }
  const counter=Math.round((c.buyPrice*(0.975+rng(state)*0.025))/1000)*1000;
  if(roll > pressure*0.55) {
    state.pendingPurchase={carId:id,offer,result:"counter",counter,finalPrice:counter};
    return {ok:true,result:"counter",offer,counter,finalPrice:counter};
  }
  state.pendingPurchase={carId:id,offer,result:"rejected"};
  return {ok:true,result:"rejected",offer};
}

function purchaseListing(state, id) {
  const c=state.market.find(x=>x.id===id);
  if(c && c.expiresAtTurn != null && c.expiresAtTurn <= (Number(state.meta.turn)||0)) {
    state.market=state.market.filter(x=>x.id!==id); refreshMarket(state);
    state.pendingPurchase=null;
    return {ok:false,reason:"expired"};
  }
  if(!c)return {ok:false,reason:"missing"};
  if(state.garage.length>=state.player.garageCapacity)return {ok:false,reason:"garage_full"};
  const negotiated=state.pendingPurchase && state.pendingPurchase.carId===id ? state.pendingPurchase : null;
  if(negotiated?.result==="rejected") return {ok:false,reason:"seller_rejected"};
  const price=negotiated?.finalPrice || c.buyPrice;
  if(state.player.balance<price)return {ok:false,reason:"no_money"};
  c.status="owned"; c.buyPrice=price; c.repairSpent=0; c.extraSpent=0;
  const hiddenPenalty=Math.min(3,Number(c.hiddenDefects)||0);
  if(hiddenPenalty>0){
    c.damage=Math.min(10,(c.damage||0)+hiddenPenalty);
    c.condition=Math.max(55,(c.condition||0)-hiddenPenalty*4);
    c.repairCost=Math.round(c.repairCost*(1+hiddenPenalty*0.12));
    c.risk=Math.min(0.8,c.risk+hiddenPenalty*0.06);
  }
  c.hiddenDefects=0; c.hiddenDefectSeverity=0;
  state.garage.push(c);
  state.market=state.market.filter(x=>x.id!==id);
  state.pendingPurchase=null;
  addTx(state,"buy",-price,"Покупка "+c.model);
  return {ok:true,car:c,price,saved:Math.max(0,c.buyPrice-price)};
}
    if(action==="refresh"){
      const removed=[];
      const pressure=(state.meta.competitionLevel||0)/100;
      const rotateCount=2;
      const sorted=[...state.market].sort((a,b)=>(a.currentDemand??a.demand)-(b.currentDemand??b.demand));
      for(const car of sorted.slice(0,rotateCount)){
        state.market=state.market.filter(x=>x.id!==car.id);
        removed.push(car.model);
      }
      refreshMarket(state);
      state.meta.day=Math.floor((Number(state.meta.turn)||0)/6)+1;
      const event=removed.length ? "\n\n🔄 Ушли: "+removed.join(", ")+"." : "";
      const pressureText=pressure>0.75 ? "\n⚠️ Высокое давление конкурентов: лучшие лоты долго не лежат." : "";
      return {text:mainText(state)+event+pressureText,markup:marketKeyboard(state)};
    }

