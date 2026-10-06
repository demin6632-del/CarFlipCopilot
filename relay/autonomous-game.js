const { Pool } = require("pg");

const VERSION = 1;
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
  const id = "car_"+Date.now().toString(36)+"_"+Math.floor(rng(state)*1e6).toString(36);
  return {
    id, model:base.name, catalogId:base.id, year:base.year, mileage,
    buyPrice:Math.max(50000,buy), marketPrice:Math.round(market),
    repairCost:Math.round(base.repair*(0.65+rng(state)*0.7)),
    targetSale:Math.round(base.sale*(0.93+rng(state)*0.12)),
    demand:base.demand, risk:Math.min(0.8,base.risk+damage*0.025),
    condition:Math.round(condition*100), damage, status:"market",
    generatedAt:Date.now()
  };
}
function refreshMarket(state) {
  while(state.market.length<5) state.market.push(createListing(state));
  return state.market;
}
function newState(chat, firstName) {
  const state = {
    version:VERSION,
    player:{name:String(firstName||"Перекуп"),level:1,xp:0,respect:0,balance:START_BALANCE,garageCapacity:GARAGE_CAPACITY},
    garage:[],
    market:[],
    transactions:[],
    plates:[],
    contracts:[{id:"first_turn",title:"Первый оборот",goal:"Получи прибыль с первой перепродажи",reward:120000,completed:false}],
    meta:{seed:seedFor(chat),turn:0,createdAt:Date.now()},
    lastAction:null
  };
  refreshMarket(state);
  return state;
}
async function load(chat, firstName) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const r=await pool.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1",[String(chat)]);
  if(r.rowCount) return r.rows[0].state;
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
async function withState(chat, firstName, mutate) {
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
    state.meta.turn=(Number(state.meta.turn)||0)+1;
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
  state.transactions.unshift({time:Date.now(),kind,amount:delta,balance:state.player.balance,description});
  state.transactions=state.transactions.slice(0,80);
}
function scoreListing(car) {
  const margin=car.targetSale-car.buyPrice-car.repairCost;
  return margin/car.buyPrice*100*car.demand*(1-car.risk);
}
function bestDeal(state) {
  return [...state.market].sort((a,b)=>scoreListing(b)-scoreListing(a))[0]||null;
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
  const rec=recommendation(state);
  return [
    "🚗 СИМУЛЯТОР ПЕРЕКУПА",
    "",
    "👤 "+p.name+" · Ур. "+p.level,
    "💰 Баланс: "+fmt(p.balance),
    "🚘 Гараж: "+state.garage.length+"/"+p.garageCapacity,
    "⭐ Репутация: "+p.respect,
    "",
    "📈 Рынок обновлён.",
    "🎯 "+rec.title,
    rec.car ? rec.car.model+" · "+fmt(rec.car.buyPrice)+" → около "+fmt(rec.car.targetSale) : rec.text,
    "",
    "Выбирай действие ниже."
  ].join("\n");
}
function menu() {
  return {inline_keyboard:[
    [{text:"🚗 Рынок",callback_data:"ag:market"},{text:"🏠 Гараж",callback_data:"ag:garage"}],
    [{text:"🧠 Что делать",callback_data:"ag:advice"},{text:"📋 Контракты",callback_data:"ag:contracts"}],
    [{text:"🔢 Номера",callback_data:"ag:plates"},{text:"📊 Статистика",callback_data:"ag:stats"}]
  ]};
}
function marketKeyboard(state) {
  return {inline_keyboard:[
    ...state.market.slice(0,5).map((c,i)=>[{text:(i+1)+". "+c.model+" · "+fmt(c.buyPrice),callback_data:"ag:inspect:"+c.id}]),
    [{text:"🔄 Обновить рынок",callback_data:"ag:refresh"}],
    [{text:"⬅️ Главное меню",callback_data:"ag:home"}]
  ]};
}
function garageKeyboard(state) {
  return {inline_keyboard:[
    ...state.garage.map((c,i)=>[{text:"🚘 "+(i+1)+". "+c.model,callback_data:"ag:car:"+c.id}]),
    [{text:"🚗 Рынок",callback_data:"ag:market"},{text:"⬅️ Меню",callback_data:"ag:home"}]
  ]};
}
function inspectText(c) {
  const margin=c.targetSale-c.buyPrice-c.repairCost;
  return [
    "🔎 ОСМОТР ЛОТА",
    "",
    "🚘 "+c.model+" · "+c.year,
    "🛣 Пробег: "+c.mileage.toLocaleString("ru-RU")+" км",
    "🧰 Состояние: "+c.condition+"%",
    "⚠️ Повреждений: "+c.damage,
    "💵 Цена входа: "+fmt(c.buyPrice),
    "🔧 Оценка ремонта: "+fmt(c.repairCost),
    "🎯 Целевая продажа: "+fmt(c.targetSale),
    "📈 Потенциальная маржа: "+fmt(margin),
    "📊 Спрос: "+Math.round(c.demand*100)+"%",
    "⚠️ Риск: "+Math.round(c.risk*100)+"%"
  ].join("\n");
}
function inspectKeyboard(c, state) {
  const free=state.garage.length<state.player.garageCapacity;
  return {inline_keyboard:[
    ...(free ? [[{text:"💳 Купить",callback_data:"ag:buy:"+c.id}]] : []),
    [{text:"⬅️ Рынок",callback_data:"ag:market"}]
  ]};
}
function carText(c) {
  const cost=c.buyPrice+(c.repairSpent||0)+(c.extraSpent||0);
  const margin=c.targetSale-cost;
  return [
    "🚘 "+c.model,
    "",
    "💵 Себестоимость: "+fmt(cost),
    "🔧 Ремонт: "+fmt(c.repairSpent||0),
    "✨ Подготовка: "+fmt(c.extraSpent||0),
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
function statsText(state) {
  const tx=state.transactions;
  const income=tx.filter(x=>x.amount>0).reduce((s,x)=>s+x.amount,0);
  const spent=tx.filter(x=>x.amount<0).reduce((s,x)=>s-x.amount,0);
  const deals=tx.filter(x=>x.kind==="sale").length;
  const profit=tx.filter(x=>x.kind==="sale").reduce((s,x)=>s+x.amount,0)-tx.filter(x=>x.kind==="buy").reduce((s,x)=>s-x.amount,0)-tx.filter(x=>x.kind==="repair"||x.kind==="prep").reduce((s,x)=>s-x.amount,0);
  return ["📊 СТАТИСТИКА","","💰 Баланс: "+fmt(state.player.balance),"📥 Оборот входящих: "+fmt(income),"📤 Расходы: "+fmt(spent),"🤝 Продаж: "+deals,"📈 Валовой результат сделок: "+fmt(profit),"🔄 Ходов: "+state.meta.turn].join("\n");
}

async function send(sendFn,chat,text,markup) {
  return sendFn(chat,text,markup?{reply_markup:markup}:undefined);
}
async function screen(sendFn,chat,state,text,markup) {
  return send(sendFn,chat,text,markup||menu());
}

async function open(chat, firstName, sendFn) {
  const state=await load(chat,firstName);
  return screen(sendFn,chat,state,mainText(state),menu());
}
async function handleText(chat,text,firstName,sendFn) {
  if(text!=="/perekup" && text!=="🎮 Автономная игра" && text!=="🚗 Симулятор Перекупа") return false;
  await open(chat,firstName,sendFn);
  return true;
}

async function handleCallback(chat,data,firstName,sendFn,answerFn) {
  if(!String(data).startsWith("ag:")) return false;
  try { await answerFn?.(); } catch {}
  const [_,action,id]=String(data).split(":");
  if(action==="home"){await open(chat,firstName,sendFn);return true;}
  const run=await withState(chat,firstName,state=>{
    if(action==="refresh"){
      state.market=[];refreshMarket(state);
      return {text:mainText(state),markup:menu()};
    }
    if(action==="market") return {text:"🚗 РЫНОК\n\nВыбирай лот для полного осмотра.",markup:marketKeyboard(state)};
    if(action==="garage") return {text:state.garage.length?("🏠 ГАРАЖ\n\n"+state.garage.map((c,i)=>(i+1)+". "+c.model+" · "+fmt(c.buyPrice+(c.repairSpent||0)+(c.extraSpent||0))).join("\n")):"🏠 ГАРАЖ\n\nПока пусто.",markup:garageKeyboard(state)};
    if(action==="advice"){
      const r=recommendation(state);
      return {text:"🧠 ЧТО ДЕЛАТЬ\n\n🎯 "+r.title+"\n"+r.text+(r.car?"\n\n👉 Лот: "+r.car.model+"\n💵 Вход: "+fmt(r.car.buyPrice)+"\n🔧 Ремонт: "+fmt(r.car.repairCost)+"\n📈 ROI: "+(r.roi?.toFixed(1)||"—")+"%":""),markup:r.car?{inline_keyboard:[[{text:"🔎 Осмотреть лот",callback_data:"ag:inspect:"+r.car.id}],[{text:"⬅️ Меню",callback_data:"ag:home"}]]}:menu()};
    }
    if(action==="inspect"){
      const c=state.market.find(x=>x.id===id);
      return c?{text:inspectText(c),markup:inspectKeyboard(c,state)}:{text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
    }
    if(action==="buy"){
      const c=state.market.find(x=>x.id===id);
      if(!c)return {text:"⚠️ Лот уже продан.",markup:marketKeyboard(state)};
      if(state.garage.length>=state.player.garageCapacity)return {text:"⚠️ Гараж заполнен.",markup:garageKeyboard(state)};
      if(state.player.balance<c.buyPrice)return {text:"❌ Недостаточно денег.",markup:marketKeyboard(state)};
      c.status="owned";c.repairSpent=0;c.extraSpent=0;
      state.garage.push(c);
      state.market=state.market.filter(x=>x.id!==id);
      addTx(state,"buy",-c.buyPrice,"Покупка "+c.model);
      return {text:"✅ ПОКУПКА ОФОРМЛЕНА\n\n"+c.model+"\n💵 Потрачено: "+fmt(c.buyPrice)+"\n💰 Остаток: "+fmt(state.player.balance),markup:carKeyboard(c)};
    }
    const c=state.garage.find(x=>x.id===id);
    if(!c && ["car","repair","prep","sell"].includes(action))return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
    if(action==="car")return {text:carText(c),markup:carKeyboard(c)};
    if(action==="repair"){
      const cost=Math.round(c.repairCost);
      if(state.player.balance<cost)return {text:"❌ Не хватает денег на ремонт.",markup:carKeyboard(c)};
      c.repairSpent=(c.repairSpent||0)+cost;c.condition=Math.min(100,c.condition+18);c.damage=Math.max(0,c.damage-2);
      addTx(state,"repair",-cost,"Ремонт "+c.model);
      return {text:"🔧 РЕМОНТ ЗАВЕРШЁН\n\n"+carText(c),markup:carKeyboard(c)};
    }
    if(action==="prep"){
      const cost=Math.round(18000+Math.max(0,c.damage)*2500);
      if(state.player.balance<cost)return {text:"❌ Не хватает денег на подготовку.",markup:carKeyboard(c)};
      c.extraSpent=(c.extraSpent||0)+cost;c.condition=Math.min(100,c.condition+6);c.targetSale=Math.round(c.targetSale*1.035);
      addTx(state,"prep",-cost,"Подготовка "+c.model);
      return {text:"✨ ПОДГОТОВКА ЗАВЕРШЕНА\n\n"+carText(c),markup:carKeyboard(c)};
    }
    if(action==="sell"){
      const cost=c.buyPrice+(c.repairSpent||0)+(c.extraSpent||0);
      const marketFactor=0.91+rng(state)*0.15;
      const offer=Math.round((c.targetSale*marketFactor)/1000)*1000;
      const profit=offer-cost;
      if(profit<0)return {text:"🛑 ПРОДАЖА ОТМЕНЕНА\n\nПокупатель предлагает "+fmt(offer)+" при себестоимости "+fmt(cost)+" .\nПотеря: "+fmt(-profit)+"\n\nРешение игры: не фиксировать убыток.",markup:carKeyboard(c)};
      state.player.respect+=profit>100000?2:1;
      state.garage=state.garage.filter(x=>x.id!==id);
      addTx(state,"sale",offer,"Продажа "+c.model+" (прибыль "+fmt(profit)+")");
      if(!state.contracts[0].completed && profit>0)state.contracts[0].completed=true;
      return {text:"💰 МАШИНА ПРОДАНА\n\n"+c.model+"\n💵 Получено: "+fmt(offer)+"\n📈 Прибыль: "+fmt(profit)+"\n💰 Баланс: "+fmt(state.player.balance),markup:garageKeyboard(state)};
    }
    if(action==="contracts")return {text:"📋 КОНТРАКТЫ\n\n"+state.contracts.map(c=>(c.completed?"✅ ":"⏳ ")+c.title+"\n   "+c.goal+"\n   Награда: "+fmt(c.reward)).join("\n\n"),markup:menu()};
    if(action==="plates")return {text:"🔢 НОМЕРА\n\nВ V1 склад номеров создаётся отдельной веткой экономики. Пока номер не влияет на баланс автоматически.",markup:menu()};
    if(action==="stats")return {text:statsText(state),markup:menu()};
    return {text:mainText(state),markup:menu()};
  });
  await screen(sendFn,chat,run.state,run.result.text,run.result.markup);
  return true;
}

module.exports={init,load,save,open,handleText,handleCallback,CATALOG};
