const { Pool } = require("pg");
const sandbox = require("./car-sandbox");

const VERSION = 2;
const START_BALANCE = 3000000;
const GARAGE_CAPACITY = 3;

const CAR_PHOTOS = {
  vesta_2019: "https://kanavto.ru/car-photos/538192lx011ystngk/large/63739ce0b378dc86a0f12a472e4dee03.jpg",
  focus_2017: "https://photos.carspecs.us/5a49a93e8890ce10feeea7a33c2055f9a50cf9e1-2000.jpg",
  octavia_2018: "https://upload.wikimedia.org/wikipedia/commons/5/5d/2018_Skoda_Octavia_SE_TDi_S-A_1.6_Front.jpg",
  camry_2015: "https://s1.cdn.autoevolution.com/images/gallery/TOYOTA-Camry-5331_53.jpg",
  mazda6_2017: "https://eu.cdn.autosonshow.tv/757/autocaptureautoimage/DG17PBV/MAZDA__6__D_SPORT_NAV__DIESEL__RED__2017__DG17PBV-e06_md.jpg",
  a4_2016: "https://commons.wikimedia.org/wiki/Special:FilePath/Audi_A4_B9_white_%281%29.jpg?width=1200",
  x1_2015: "https://mediapool.bmwgroup.com/cache/P9/201509/P90198967/P90198967-bmw-x1-25d-xline-2015-2250px.jpg",
  qashqai_2018: "https://upload.wikimedia.org/wikipedia/commons/a/a6/2018_Nissan_Qashqai_%28J11%29_ST_wagon_%282018-11-02%29.jpg"
};

function carPhotoFor(car) {
  return CAR_PHOTOS[car?.catalogId] || null;
}
function normalizeCarModelName(value) {
  return String(value||"").toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ").trim();
}
function carMatchesFromText(text) {
  const body=normalizeCarModelName(text);
  return CATALOG
    .slice()
    .sort((a,b)=>String(b.name).length-String(a.name).length)
    .filter(car=>body.includes(normalizeCarModelName(car.name)));
}
function carPhotoEntriesFromText(text) {
  const seen=new Set();
  return carMatchesFromText(text).filter(car=>{
    if(seen.has(car.id)||!CAR_PHOTOS[car.id]) return false;
    seen.add(car.id);
    return true;
  }).map(car=>({car,url:CAR_PHOTOS[car.id]}));
}
function carPhotoFromText(text) {
  return carPhotoEntriesFromText(text)[0]?.url || null;
}
function carPhotoFromState(state, text) {
  const fromText=carPhotoFromText(text);
  if(fromText) return fromText;
  const pending=state?.pendingPurchase?.carId || state?.pendingDeal?.carId;
  if(pending){
    const car=[...(state.market||[]),...(state.garage||[])].find(x=>String(x.id)===String(pending));
    const photo=carPhotoFor(car);
    if(photo) return photo;
  }
  return null;
}

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
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized:false },
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 7000,
      statement_timeout: 7000
    });
    // pg emits "error" on the pool when an idle client loses its connection.
    // Without a listener Node treats that event as uncaught and may destabilize the bot.
    pool.on("error", error => {
      console.error("AUTONOMOUS GAME POOL ERROR:", error?.message || error);
    });
    poolPromise = Promise.resolve(pool);
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
    CREATE TABLE IF NOT EXISTS autonomous_container_battles (
      id bigserial PRIMARY KEY,
      status text NOT NULL DEFAULT 'open',
      owner_chat_id text NOT NULL,
      entry_fee bigint NOT NULL DEFAULT 100000,
      players jsonb NOT NULL DEFAULT '[]'::jsonb,
      results jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS autonomous_container_battles_status_idx
      ON autonomous_container_battles(status,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS autonomous_container_battles_one_open_idx
      ON autonomous_container_battles(status) WHERE status='open';
    CREATE TABLE IF NOT EXISTS autonomous_street_duels (
      id bigserial PRIMARY KEY, status text NOT NULL DEFAULT 'open',
      challenger_chat_id text NOT NULL, challenger_name text NOT NULL,
      challenger_car jsonb NOT NULL, challenger_power integer NOT NULL,
      opponent_chat_id text, opponent_name text, opponent_car jsonb,
      opponent_power integer, stake bigint NOT NULL DEFAULT 50000,
      result jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS autonomous_street_duels_status_idx
      ON autonomous_street_duels(status,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS autonomous_street_duels_one_open_idx
      ON autonomous_street_duels(status) WHERE status='open';
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
    id, model:base.name, catalogId:base.id, year:base.year, plate:createUniqueVehiclePlate(state), mileage,
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
function createUniqueVehiclePlate(state) {
  if(!state.meta) state.meta={};
  if(!Array.isArray(state.meta.vehiclePlatesIssued)) state.meta.vehiclePlatesIssued=[];
  const used=new Set([
    ...state.meta.vehiclePlatesIssued,
    ...(state.garage||[]).map(car=>car.plate),
    ...(state.market||[]).map(car=>car.plate)
  ].filter(Boolean));
  let plate;
  do { plate=plateCode(state); } while(used.has(plate));
  state.meta.vehiclePlatesIssued.push(plate);
  return plate;
}
function ensureVehiclePlates(state) {
  if(!state||!state.meta) return;
  state.garage=Array.isArray(state.garage)?state.garage:[];
  state.market=Array.isArray(state.market)?state.market:[];
  if(!Array.isArray(state.meta.vehiclePlatesIssued)) state.meta.vehiclePlatesIssued=[];
  // "issued" is a historical registry, not a set of plates that must be
  // rejected when encountered on the same vehicle again.
  const issued=new Set(state.meta.vehiclePlatesIssued.filter(Boolean));
  const seenCurrent=new Set();
  for(const car of [...state.garage,...state.market]) {
    const current=String(car.plate||"").trim();
    if(!current||seenCurrent.has(current)) {
      let plate;
      do { plate=plateCode(state); } while(issued.has(plate)||seenCurrent.has(plate));
      car.plate=plate;
    }
    seenCurrent.add(car.plate);
    issued.add(car.plate);
  }
  // Preserve retired plates forever while adding any legacy active plates.
  state.meta.vehiclePlatesIssued=[...issued];
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
  const risk = Math.max(0, Math.min(0.8, car.risk - car.condition / 1000 + (car.mileageRolledBack ? Number(car.odometerRisk||0.24) : 0)));
  const roll = rng(state);
  if (car.mileageRolledBack && roll < risk * 0.30) {
    const penalty=Math.round((45000+rng(state)*95000)/1000)*1000;
    return {type:"incident",penalty,text:"Покупатель проверил историю и обнаружил несоответствие пробега."};
  }
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
    player:{name:String(firstName||"Перекуп"),level:1,xp:0,respect:0,balance:START_BALANCE,garageCapacity:GARAGE_CAPACITY,debt:0,loanDueDay:0,containerParts:[]},
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
    ensureVehiclePlates(state);
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
    ensureVehiclePlates(state);
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

function financeText(state) {
  const p=state.player, debt=Math.max(0,Number(p.debt)||0);
  return ["🏦 БАНК И КРЕДИТЫ","",
    "💰 Свободные средства: "+fmt(p.balance),
    "💳 Текущий долг: "+fmt(debt),
    debt>0 ? "📅 Погасить до: день "+(p.loanDueDay||"—") : "✅ Активных кредитов нет.",
    "",
    "Кредитный лимит — до 50 000 000 ₽. Комиссия за пользование — 15% от суммы, срок — 30 игровых дней. Досрочное погашение доступно."
  ].join("\n");
}
function financeKeyboard(state) {
  const debt=Math.max(0,Number(state.player.debt)||0), free=Math.max(0,50000000-debt);
  const amounts=[500000,1000000,3000000,5000000,10000000,25000000,50000000].filter(x=>x<=free);
  return {inline_keyboard:[
    ...amounts.map(x=>[{text:"💳 Взять "+fmt(x),callback_data:"ag:borrow:"+x}]),
    ...(debt>0?[[{text:"💸 Погасить весь долг · "+fmt(debt),callback_data:"ag:repay"}]]:[]),
    [{text:"⬅️ Меню",callback_data:"ag:home"}]
  ]};
}
function mainText(state) {
  const p=state.player, event=state.meta.marketEvent||{title:"Спокойный рынок",text:"Стабильный спрос."};
  const deals=state.transactions.filter(x=>x.kind==="sale").length;
  return ["🚗 СИМУЛЯТОР ПЕРЕКУПА · V2","","👤 "+p.name+" · Ур. "+p.level+" · ⭐ "+p.respect,
    "💰 "+fmt(p.balance)+" · 🚘 "+state.garage.length+"/"+p.garageCapacity,
    "📅 День "+(state.meta.day||1)+" · Продаж: "+deals,"","📈 "+event.title,event.text,
    "👥 Конкуренты: "+(state.meta.competitors||1)+" · давление "+(state.meta.competitionLevel||0)+"%","",
    "Цель дня: найти недооценённую машину,","проверить её, сторговаться, вложиться","только там, где это окупается, и продать.","",
    "Решение всегда остаётся за тобой."].join("\n");
}
function menu() {
  return {inline_keyboard:[
    [{text:"🚗 Рынок",callback_data:"ag:market"},{text:"🏠 Гараж",callback_data:"ag:garage"}],
    [{text:"📅 Сегодня",callback_data:"ag:day"},{text:"📋 Контракты",callback_data:"ag:contracts"}],
    [{text:"🔢 Номера",callback_data:"ag:plates"},{text:"📊 Статистика",callback_data:"ag:stats"}],
    [{text:"🏦 Банк",callback_data:"ag:finance"},{text:"🏆 Рейтинг игроков",callback_data:"ag:leaderboard"}],
    [{text:"📦 Контейнеры",callback_data:"ag:containers"}],
    [{text:"⚔️ Сражения",callback_data:"ag:battle"}],
    [{text:"🏁 Уличные дуэли",callback_data:"ag:duel"}],
    [{text:"🏆 Чемпионат",callback_data:"ag:championship"}]
  ]};
}
function marketKeyboard(state) {
  const turn=Number(state.meta.turn)||0;
  return {inline_keyboard:[...state.market.slice(0,5).map((car,i)=>{
    const left=car.expiresAtTurn?Math.max(0,car.expiresAtTurn-turn):0, tag=car.limited?"🔥 ":"";
    const margin=car.targetSale-car.buyPrice-car.repairCost;
    const signal=margin>150000?"💎":margin>50000?"🟢":margin>0?"🟡":"🔴";
    return [{text:tag+(i+1)+". "+signal+" "+car.model+" · "+(car.plate||"без номера")+" · "+fmt(car.buyPrice)+(car.expiresAtTurn?" · ⏳"+left:""),callback_data:"ag:inspect:"+car.id}];
  }),[{text:"🔄 Обновить рынок",callback_data:"ag:refresh"}],[{text:"⬅️ Меню",callback_data:"ag:home"}]]};
}
function garageKeyboard(state) {
  return {inline_keyboard:[
    ...state.garage.map((c,i)=>[{text:"🚘 "+(i+1)+". "+c.model+" · "+(c.plate||"без номера"),callback_data:"ag:car:"+c.id}]),
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
  const margin=c.targetSale-c.buyPrice-c.repairCost, gap=c.marketPrice-c.buyPrice;
  const low=Math.max(0,Math.round(margin*.55/1000)*1000), high=Math.max(0,Math.round(margin*1.05/1000)*1000);
  return ["🔎 ОСМОТР ЛОТА","","🚘 "+c.model+" · "+c.year,"🔢 Госномер: "+(c.plate||"не назначен"),"🛣 "+c.mileage.toLocaleString("ru-RU")+" км · состояние "+c.condition+"%",
    "⚠️ Повреждений: "+c.damage+" · риск "+Math.round(c.risk*100)+"%","💵 Цена продавца: "+fmt(c.buyPrice),
    "📊 Средняя цена рынка: "+fmt(c.marketPrice),"🔧 Оценка ремонта: "+fmt(c.repairCost),
    "🎯 Ориентир продажи: "+fmt(c.targetSale),"📈 Разница с рынком: "+fmt(gap),
    "💰 Расчётная прибыль: "+fmt(margin),"🎲 Реалистичный диапазон: "+fmt(low)+" — "+fmt(high),
    "📊 Спрос: "+Math.round((c.currentDemand??c.demand)*100)+"%","🛣 Пробег: "+c.mileage.toLocaleString("ru-RU")+" км",c.mileageRolledBack?"⚠️ История пробега изменена.":"📋 История пробега: без вмешательств.",revealRiskText(c),hiddenDefectLabel(c),
    c.limited?"🔥 Срочный лот — времени мало.":"📦 Обычный лот.",
    c.expiresAtTurn?"⏳ До ухода с рынка: "+Math.max(0,c.expiresAtTurn-(Number(state.meta.turn)||0))+" ход.":""].join("\n");
}
function purchaseOfferText(state,c) {
  const p=state.pendingPurchase;
  return ["💬 ТОРГ С ПРОДАВЦОМ","","🚘 "+c.model,"💵 Цена продавца: "+fmt(c.buyPrice),
    "🤝 Твоё предложение: "+fmt(p.offer),
    p.result==="accepted"?"✅ Продавец согласился.":p.result==="counter"?"↔️ Встречное предложение: "+fmt(p.counter):"❌ Продавец отказался.",
    "","⚠️ После покупки скрытые расходы всё ещё возможны."].join("\n");
}
function inspectKeyboard(c,state) {
  const free=state.garage.length<state.player.garageCapacity;
  return {inline_keyboard:[
    [{text:"🔎 Быстрая диагностика · 12 000 ₽",callback_data:"ag:diagnose:"+c.id}],
    [{text:"🔬 Глубокая диагностика · 35 000 ₽",callback_data:"ag:diagnose_deep:"+c.id}],
    ...(free?[[{text:"💬 Торговаться",callback_data:"ag:offer:"+c.id}],[{text:"💳 Купить за "+fmt(c.buyPrice),callback_data:"ag:buy:"+c.id}]]:[]),
    [{text:"⬅️ Рынок",callback_data:"ag:market"}]]};
}
function sandboxText(c) {
  sandbox.buildCar(c);
  const summary=sandbox.carSandboxSummary(c);
  return [
    "🧩 ДЕТАЛИ АВТОМОБИЛЯ","",
    "🔩 Деталей: "+summary.totalParts+" · установлено "+summary.installedParts,
    "📊 Среднее состояние: "+summary.averageCondition+"%",
    summary.hiddenDefects>0 ? "⚠️ Скрытые проблемы: "+summary.hiddenDefects : "✅ Скрытых проблем не выявлено",
    summary.legalRisk ? "⚠️ Есть отметка о вмешательстве в историю." : "✅ История без критических отметок."
  ].join("\n");
}
const CAR_DETAIL_GROUPS=[
  {id:"engine",title:"Двигатель",icon:"🔧",systems:["engine"]},
  {id:"transmission",title:"Трансмиссия",icon:"⚙️",systems:["transmission"]},
  {id:"chassis",title:"Подвеска",icon:"🛞",systems:["chassis"]},
  {id:"brakes",title:"Тормоза",icon:"🛑",systems:["brakes"]},
  {id:"electrical",title:"Электрика",icon:"🔋",systems:["electrical"]},
  {id:"hood",title:"Капот",icon:"🧢",systems:["body"],assemblies:["hood"]},
  {id:"doors",title:"Двери",icon:"🚪",systems:["body"],assemblies:["door_l","door_r"]},
  {id:"fenders",title:"Крылья",icon:"🛡️",systems:["body"],assemblies:["fender_l","fender_r"]},
  {id:"bumper",title:"Бампер",icon:"🚗",systems:["body"],assemblies:["bumper"]},
  {id:"seats",title:"Сиденья",icon:"🪑",systems:["interior"],assemblies:["driver_seat"]},
  {id:"dashboard",title:"Панель",icon:"📟",systems:["interior"],assemblies:["dashboard"]},
  {id:"wheels",title:"Колёса",icon:"🛞",systems:["wheels"]},
  {id:"options",title:"Опции",icon:"🎛️",systems:["options"]}
];

function carDetailGroup(groupId){
  return CAR_DETAIL_GROUPS.find(g=>g.id===groupId)||null;
}

function sandboxGroupParts(c,group){
  sandbox.buildCar(c);
  const parts=c.sandbox.parts.filter(p=>{
    if(group.assemblies) return group.assemblies.includes(p.assembly);
    return group.systems.includes(p.system);
  });
  return parts;
}

function sandboxGroupAverage(parts){
  return parts.length?Math.round(parts.reduce((sum,p)=>sum+p.condition,0)/parts.length):0;
}

function sandboxGroupKeyboard(c,groupId){
  const group=carDetailGroup(groupId);
  if(!group) return sandboxSystemsKeyboard(c);
  const parts=sandboxGroupParts(c,group);
  return {inline_keyboard:[
    ...parts.map(p=>[{text:(p.installed?"🔩 ":"📦 ")+p.name+" · "+p.condition+"%",callback_data:"ag:part:"+c.id+"|"+p.id}]),
    [{text:"⬅️ Детали автомобиля",callback_data:"ag:parts:"+c.id}]
  ]};
}

function sandboxSystemsKeyboard(c) {
  sandbox.buildCar(c);
  const bySystem=sandbox.listSystems(c);
  return {inline_keyboard:[
    ...CAR_DETAIL_GROUPS.map(group=>{
      const parts=sandboxGroupParts(c,group);
      const avg=sandboxGroupAverage(parts);
      return [{text:group.icon+" "+group.title+" · "+avg+"%",callback_data:"ag:system:"+c.id+"|group_"+group.id}];
    }),
    [{text:"🛒 Рынок деталей",callback_data:"ag:pmrefresh:"+c.id}],
    [{text:"🔧 Полная разборка",callback_data:"ag:global:"+c.id+"|full_disassembly"}],
    [{text:"⬅️ Машина",callback_data:"ag:car:"+c.id}]
  ]};
}
function sandboxPartsKeyboard(c,systemId) {
  const parts=sandbox.listParts(c,systemId);
  return {inline_keyboard:[
    ...parts.map(p=>[{text:(p.installed?"🔩 ":"📦 ")+p.name+" · "+p.condition+"%",callback_data:"ag:part:"+c.id+"|"+p.id}]),
    [{text:"⬅️ Системы",callback_data:"ag:parts:"+c.id}]
  ]};
}
function sandboxPartText(p) {
  return [
    "🔩 ДЕТАЛЬ","",
    p.name,
    "Состояние: "+p.condition+"%",
    "Износ: "+p.wear+"%",
    "Статус: "+(p.installed?"установлена":"снята"),
    p.hiddenDamage ? "⚠️ Есть скрытое повреждение." : "✅ Скрытых повреждений не выявлено."
  ].join("\n");
}
function sandboxPartKeyboard(c,p) {
  return {inline_keyboard:[
    [{text:"🔧 Ремонт",callback_data:"ag:pa:"+c.id+"|"+p.id+"|repair"},{text:p.installed?"🔩 Снять":"🔩 Установить",callback_data:"ag:pa:"+c.id+"|"+p.id+"|"+(p.installed?"remove":"install")}],
    [{text:"🆕 Новая",callback_data:"ag:pa:"+c.id+"|"+p.id+"|replace_new"},{text:"♻️ Б/у",callback_data:"ag:pa:"+c.id+"|"+p.id+"|replace_used"}],
    [{text:"💰 Продать отдельно",callback_data:"ag:pa:"+c.id+"|"+p.id+"|sell_part"}],
    [{text:"⬅️ Детали",callback_data:"ag:parts:"+c.id}]
  ]};
}
function sandboxPartKeyboard(c,p) {
  return {inline_keyboard:[
    [{text:"🔧 Ремонт",callback_data:"ag:pa:"+c.id+"|"+p.id+"|repair"},{text:p.installed?"🔩 Снять":"🔩 Установить",callback_data:"ag:pa:"+c.id+"|"+p.id+"|"+(p.installed?"remove":"install")}],
    [{text:"🧷 Крепёж",callback_data:"ag:fasteners:"+c.id+"|"+p.id}],
    [{text:"🆕 Новая",callback_data:"ag:pa:"+c.id+"|"+p.id+"|replace_new"},{text:"♻️ Б/у",callback_data:"ag:pa:"+c.id+"|"+p.id+"|replace_used"}],
    [{text:"💰 Продать отдельно",callback_data:"ag:pa:"+c.id+"|"+p.id+"|sell_part"}],
    [{text:"⬅️ Детали",callback_data:"ag:parts:"+c.id}]
  ]};
}
function sandboxAssembliesKeyboard(c,systemId) {
  sandbox.buildCar(c);
  return {inline_keyboard:[
    ...sandbox.listAssemblies(c,systemId).map(a=>[{text:"🔧 "+a.title+" · "+a.averageCondition+"%",callback_data:"ag:assembly:"+c.id+"|"+a.id+"|"+systemId}]),
    [{text:"⬅️ Система",callback_data:"ag:system:"+c.id+"|"+systemId}]
  ]};
}
function sandboxFastenerText(f) {
  return ["🧷 КРЕПЁЖ","",f.title,"Тип: "+f.type,"Размер: "+f.spec,"Состояние: "+f.condition+"%",
    "Статус: "+(f.installed?"установлен":"снят"),"Цена: "+fmt(f.marketValue)].join("\n");
}
function sandboxFastenersKeyboard(c,p) {
  const list=sandbox.listFasteners(c,p.id);
  return {inline_keyboard:[
    ...list.map(f=>[{text:(f.installed?"🔩 ":"📦 ")+f.title+" "+f.spec+" · "+f.condition+"%",callback_data:"ag:fa:"+c.id+"|"+(f.installed?"unscrew":"screw")+"|"+p.id+"|"+f.id}]),
    [{text:"🔧 Заменить первый крепёж",callback_data:"ag:fa:"+c.id+"|replace|"+p.id+"|"+(list[0]?.id||"")}],
    [{text:"⬅️ Деталь",callback_data:"ag:part:"+c.id+"|"+p.id}]
  ]};
}
function sandboxWarehouseText(c) {
  sandbox.buildCar(c);
  const list=c.sandbox.warehouse||[];
  if(!list.length) return "📦 СКЛАД ДЕТАЛЕЙ\n\nСклад пуст.\n\nМожно снять деталь с другой машины-донора и передать её сюда.";
  return "📦 СКЛАД ДЕТАЛЕЙ\n\n"+list.map((p,i)=>{
    const pr=p.provenance||{};
    return (i+1)+". "+p.name+" · "+p.condition+"%\n   VIN донора: "+(pr.sourceVin||"—")+"\n   Серийный номер: "+(p.serial||"—")+"\n   Снята: "+(pr.extractedAt?new Date(pr.extractedAt).toLocaleString("ru-RU"):"—");
  }).join("\n\n");
}
function sandboxWarehouseKeyboard(c,state) {
  sandbox.buildCar(c);
  const list=c.sandbox.warehouse||[];
  const donorCars=state.garage.filter(x=>String(x.id)!==String(c.id));
  return {inline_keyboard:[
    ...list.map(p=>[
      {text:"🔍 "+p.name,callback_data:"ag:winfo:"+c.id+"|"+p.id},
      {text:"🔧 Установить",callback_data:"ag:winstall:"+c.id+"|"+p.id}
    ]),
    ...list.map(p=>[{text:"💰 Продать "+p.name,callback_data:"ag:wsell:"+c.id+"|"+p.id}]),
    ...donorCars.map(d=>[{text:"🚘 Донор: "+d.model,callback_data:"ag:donor:"+c.id+"|"+d.id}]),
    [{text:"⬅️ Детали",callback_data:"ag:parts:"+c.id}]
  ]};
}
function sandboxDonorKeyboard(target,donor) {
  sandbox.buildCar(donor);
  return {inline_keyboard:[
    ...donor.sandbox.parts.filter(p=>p.installed).map(p=>[{text:"📦 Снять "+p.name+" · "+p.condition+"%",callback_data:"ag:extract:"+target.id+"|"+donor.id+"|"+p.id}]),
    [{text:"⬅️ Склад",callback_data:"ag:warehouse:"+target.id}]
  ]};
}
function sandboxWarehouseInfo(c,p) {
  const pr=p.provenance||{};
  return [
    "🔍 СКЛАДСКАЯ ДЕТАЛЬ","",
    "Деталь: "+p.name,
    "Состояние: "+p.condition+"%",
    "Серийный номер: "+(p.serial||"—"),
    "VIN донора: "+(pr.sourceVin||"—"),
    "ID исходной детали: "+(pr.originalPartId||"—"),
    "Состояние при снятии: "+(pr.extractedCondition??p.condition)+"%",
    "Дата снятия: "+(pr.extractedAt?new Date(pr.extractedAt).toLocaleString("ru-RU"):"—"),
    "Статус: "+(p.warehouseStatus||"stored")
  ].join("\n");
}
function sandboxMarketText(c,filters={}) {
  sandbox.buildCar(c);
  const offers=sandbox.listPartMarket(c,filters);
  const summary=sandbox.partMarketSummary(c);
  if(!offers.length) return "🧩 РЫНОК ДЕТАЛЕЙ\n\nПредложений по выбранному фильтру нет.";
  return [
    "🧩 РЫНОК ДЕТАЛЕЙ",
    "",
    "Лотов: "+offers.length+" · Всего в рынке: "+summary.total,
    "",
    ...offers.slice(0,12).map((o,i)=>
      (i+1)+". "+o.name+"\n   "+o.sourceTitle+" · "+o.type+" · "+o.condition+"%\n   💵 "+fmt(o.price)+" ₽ · "+o.seller
    )
  ].join("\n");
}
function sandboxMarketKeyboard(c,filters={}) {
  const offers=sandbox.listPartMarket(c,filters).slice(0,12);
  return {inline_keyboard:[
    ...offers.map(o=>[{text:"🛒 "+o.name+" · "+fmt(o.price)+" ₽",callback_data:"ag:pmbuy:"+c.id+"|"+o.id}]),
    [{text:"🏪 Магазин",callback_data:"ag:pmsrc:"+c.id+"|store"},{text:"🔧 Разборка",callback_data:"ag:pmsrc:"+c.id+"|dismantler"}],
    [{text:"👤 Частник",callback_data:"ag:pmsrc:"+c.id+"|private"},{text:"🚗 Донор",callback_data:"ag:pmsrc:"+c.id+"|donor"}],
    [{text:"🇨🇳 Китай",callback_data:"ag:pmsrc:"+c.id+"|china"},{text:"🔄 Обновить рынок",callback_data:"ag:pmrefresh:"+c.id}],
    [{text:"📦 Склад",callback_data:"ag:warehouse:"+c.id},{text:"⬅️ Детали",callback_data:"ag:parts:"+c.id}]
  ]};
}
function sandboxMarketOfferText(offer) {
  return [
    "🛒 ЛОТ РЫНКА ДЕТАЛЕЙ",
    "",
    "Деталь: "+offer.name,
    "Источник: "+offer.sourceTitle,
    "Продавец: "+offer.seller,
    "Тип: "+offer.type,
    "Состояние: "+offer.condition+"%",
    "Надёжность: "+Math.round(offer.reliability*100)+"%",
    "Цена: "+fmt(offer.price)+" ₽",
    "Серийный номер: "+offer.serial,
    "",
    "Совместимость: "+offer.system+" / "+offer.assembly,
    "Происхождение: "+offer.sourceTitle
  ].join("\n");
}
function carText(c) {
  const cost=vehicleCost(c);
  const margin=c.targetSale-cost;
  return [
    "🚘 "+c.model,
    "🔢 Госномер: "+(c.plate||"не назначен"),
    "",
    "💵 Себестоимость: "+fmt(cost),
    "🔧 Ремонт: "+fmt(c.repairSpent||0),
    "✨ Подготовка: "+fmt(c.extraSpent||0),
    "🔎 Диагностика: "+fmt(c.diagnosticsSpent||0),
    "🎯 Ориентир продажи: "+fmt(c.targetSale),
    "🛣 Пробег: "+Number(c.mileage||0).toLocaleString("ru-RU")+" км"+(c.mileageRolledBack?" · ⚠️ изменён":" · оригинальный"),
    "📈 Результат до продажи: "+fmt(margin)
  ].join("\n");
}
function carKeyboard(c) {
  return {inline_keyboard:[
    [{text:"🔧 Ремонт",callback_data:"ag:repair:"+c.id},{text:"✨ Подготовить",callback_data:"ag:prep:"+c.id}],
    [{text:"💰 Продать",callback_data:"ag:sell:"+c.id}],
    ...(!c.mileageRolledBack && Number(c.mileage)>30000 ? [[{text:"🌀 Корректировать пробег · 25 000 ₽",callback_data:"ag:rollback:"+c.id}]] : []),
    [{text:"🔎 Диагностика",callback_data:"ag:diag:"+c.id+"|1"},{text:"🧩 Детали автомобиля",callback_data:"ag:parts:"+c.id}],
    [{text:"📦 Склад деталей",callback_data:"ag:warehouse:"+c.id},{text:"🛒 Рынок деталей",callback_data:"ag:pmrefresh:"+c.id}],
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
    ...(deal.event==="incident" ? ["⚠️ Риск сделки: "+(deal.eventText||"обнаружен дополнительный риск"),"💸 Снижение предложения: "+fmt(deal.eventPenalty||0)] : []),
    ...(deal.event==="bonus" ? ["✨ Событие рынка: "+(deal.eventText||"спрос вырос"),"💰 Доплата: "+fmt(deal.eventBonus||0)] : []),
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
async function getContainerBattle() {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const r=await pool.query("SELECT id,status,owner_chat_id,entry_fee,players,results,created_at FROM autonomous_container_battles WHERE status='open' ORDER BY created_at DESC LIMIT 1");
  return r.rows[0]||null;
}
async function containerBattleForPlayer(chat) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const r=await pool.query("SELECT id,status,owner_chat_id,entry_fee,players,results,created_at,finished_at FROM autonomous_container_battles WHERE players @> $1::jsonb ORDER BY created_at DESC LIMIT 1",[JSON.stringify([{chatId:String(chat)}])]);
  return r.rows[0]||null;
}
function battleText(battle,chat) {
  if(!battle)return "📦 КОНТЕЙНЕРНЫЕ СРАЖЕНИЯ\n\nОткрытых комнат пока нет. Создай комнату и пригласи других игроков.\n\nВзнос: 100 000 ₽ · до 10 участников.";
  const players=Array.isArray(battle.players)?battle.players:[];
  const results=Array.isArray(battle.results)?battle.results:[];
  const mine=players.find(x=>String(x.chatId)===String(chat));
  if(battle.status==="finished"){
    const rows=results.slice().sort((a,b)=>a.rank-b.rank).map(x=>x.rank+". "+x.name+" — "+fmt(x.reward));
    return ["🏁 РЕЗУЛЬТАТЫ КОНТЕЙНЕРНОЙ БИТВЫ #"+battle.id,"","Участников: "+players.length,"Твой результат: "+(results.find(x=>String(x.chatId)===String(chat))?.rank||"—")+" место","",""+rows.join("\n"),"","Награды уже зачислены на игровые счета."].join("\n");
  }
  return ["📦 КОНТЕЙНЕРНАЯ БИТВА #"+battle.id,"","Статус: набор участников","Взнос: "+fmt(battle.entry_fee),"Участников: "+players.length+"/10","",...players.map((x,i)=>(i+1)+". "+x.name+(String(x.chatId)===String(chat)?" · ты":"")),"",mine?"Ты уже в комнате. Ожидай начала битвы.":"Вступай в комнату, чтобы принять участие."].join("\n");
}
function battleKeyboard(battle,chat) {
  if(!battle)return {inline_keyboard:[[{text:"➕ Создать комнату · 100 000 ₽",callback_data:"ag:battle_create"}],[{text:"⬅️ Контейнеры",callback_data:"ag:containers"}]]};
  if(battle.status==="finished")return {inline_keyboard:[[{text:"📦 Контейнеры",callback_data:"ag:containers"}],[{text:"⬅️ Главное меню",callback_data:"ag:home"}]]};
  const players=Array.isArray(battle.players)?battle.players:[];
  const mine=players.some(x=>String(x.chatId)===String(chat));
  return {inline_keyboard:[
    ...(!mine&&players.length<10?[[{text:"⚔️ Вступить · "+fmt(battle.entry_fee),callback_data:"ag:battle_join:"+battle.id}]]:[]),
    [{text:"🔄 Обновить комнату",callback_data:"ag:battle"}],
    ...(String(battle.owner_chat_id)===String(chat)&&players.length>=2?[[{text:"🏁 Начать битву",callback_data:"ag:battle_start:"+battle.id}]]:[]),
    [{text:"📦 Контейнеры",callback_data:"ag:containers"}]
  ]};
}
async function createContainerBattle(chat,name) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(834721905)");
    const active=await client.query("SELECT id FROM autonomous_container_battles WHERE status='open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE");
    if(active.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"exists",battle:await getContainerBattle()};}
    const profile=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    if(!profile.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    const state=profile.rows[0].state;
    if(Number(state.player?.balance||0)<100000){await client.query("ROLLBACK");return {ok:false,reason:"money"};}
    state.player.balance-=100000;
    state.transactions=Array.isArray(state.transactions)?state.transactions:[];
    state.transactions.unshift({time:Date.now(),kind:"container_battle_entry",amount:-100000,balance:state.player.balance,description:"Взнос в контейнерную битву",profit:0});
    state.transactions=state.transactions.slice(0,80);
    if(callbackId){state.processedCallbacks.push(String(callbackId));state.processedCallbacks=state.processedCallbacks.slice(-80);}
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(state)]);
    const r=await client.query("INSERT INTO autonomous_container_battles(status,owner_chat_id,entry_fee,players) VALUES('open',$1,100000,$2::jsonb) RETURNING id,status,owner_chat_id,entry_fee,players,results,created_at",[String(chat),JSON.stringify([{chatId:String(chat),name:String(name||"Перекуп")}])]);
    await client.query("COMMIT");return {ok:true,battle:r.rows[0]};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}
async function joinContainerBattle(chat,name,battleId) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM autonomous_container_battles WHERE id=$1 AND status='open' FOR UPDATE",[Number(battleId)]);
    if(!r.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"closed"};}
    const battle=r.rows[0], players=Array.isArray(battle.players)?battle.players:[];
    if(players.some(x=>String(x.chatId)===String(chat))){await client.query("ROLLBACK");return {ok:false,reason:"joined",battle};}
    if(players.length>=10){await client.query("ROLLBACK");return {ok:false,reason:"full"};}
    const active=await client.query("SELECT id FROM autonomous_container_battles WHERE status='open' AND players @> $1::jsonb LIMIT 1",[JSON.stringify([{chatId:String(chat)}])]);
    if(active.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"other_room"};}
    const charge=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    if(!charge.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    const state=charge.rows[0].state;
    if(Number(state.player?.balance||0)<Number(battle.entry_fee)){await client.query("ROLLBACK");return {ok:false,reason:"money"};}
    state.player.balance-=Number(battle.entry_fee);
    state.transactions=Array.isArray(state.transactions)?state.transactions:[];
    state.transactions.unshift({time:Date.now(),kind:"container_battle_entry",amount:-Number(battle.entry_fee),balance:state.player.balance,description:"Взнос в контейнерную битву #"+battle.id,profit:0});
    state.transactions=state.transactions.slice(0,80);
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(state)]);
    players.push({chatId:String(chat),name:String(name||"Перекуп")});
    const upd=await client.query("UPDATE autonomous_container_battles SET players=$2::jsonb WHERE id=$1 RETURNING id,status,owner_chat_id,entry_fee,players,results,created_at",[battle.id,JSON.stringify(players)]);
    await client.query("COMMIT");return {ok:true,battle:upd.rows[0]};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}
async function startContainerBattle(chat,battleId) {
  const p=db(); if(!p) throw new Error("DATABASE_URL не настроен");
  const pool=await p;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM autonomous_container_battles WHERE id=$1 AND status='open' FOR UPDATE",[Number(battleId)]);
    if(!r.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"closed"};}
    const battle=r.rows[0], players=Array.isArray(battle.players)?battle.players:[];
    if(String(battle.owner_chat_id)!==String(chat)){await client.query("ROLLBACK");return {ok:false,reason:"owner"};}
    if(players.length<2){await client.query("ROLLBACK");return {ok:false,reason:"few"};}
    const poolMoney=players.length*Number(battle.entry_fee), payout=Math.floor(poolMoney*.9);
    const ranked=players.map(x=>({...x,score:Math.random()})).sort((a,b)=>b.score-a.score);
    const results=ranked.map((x,i)=>({...x,rank:i+1,reward:i===0?Math.floor(payout*(players.length===2?.65:.55)):i===1?Math.floor(payout*(players.length===2?.35:.30)):i===2?Math.floor(payout*.15):0}));
    let paid=0;
    for(const result of results){
      if(!result.reward)continue;
      const stateRow=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(result.chatId)]);
      if(!stateRow.rowCount)continue;
      const state=stateRow.rows[0].state;
      state.player.balance=Number(state.player.balance||0)+result.reward;
      state.transactions=Array.isArray(state.transactions)?state.transactions:[];
      state.transactions.unshift({time:Date.now(),kind:"container_battle_prize",amount:result.reward,balance:state.player.balance,description:"Награда за "+result.rank+" место в битве #"+battle.id,profit:0});
      state.transactions=state.transactions.slice(0,80);
      await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(result.chatId),JSON.stringify(state)]);
      paid+=result.reward;
    }
    const upd=await client.query("UPDATE autonomous_container_battles SET status='finished',results=$2::jsonb,finished_at=now() WHERE id=$1 RETURNING id,status,owner_chat_id,entry_fee,players,results,created_at,finished_at",[battle.id,JSON.stringify(results)]);
    await client.query("COMMIT");return {ok:true,battle:upd.rows[0],paid};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}


const STREET_DUEL_STAKE=50000;
const DUEL_BASE_POWER={vesta_2019:106,focus_2017:125,octavia_2018:150,camry_2015:181,mazda6_2017:150,a4_2016:170,x1_2015:192,qashqai_2018:144};
function streetDuelPower(sourceCar){
  const car=clone(sourceCar);sandbox.buildCar(car);
  const parts=car.sandbox.parts.filter(p=>p.installed);
  const average=system=>{const a=parts.filter(p=>p.system===system);return a.length?a.reduce((n,p)=>n+Number(p.condition||0),0)/a.length:70;};
  const condition=Math.max(50,Math.min(100,Number(car.condition)||75));
  const mileage=Math.max(0,Number(car.mileage)||0);
  const tune=car.sandbox.flags?.ecuTune?1.08:1;
  const integrity=0.72+condition/360+average("engine")/1200+average("transmission")/1600+average("wheels")/2200;
  const mileageFactor=Math.max(0.88,1-Math.max(0,mileage-50000)/2500000);
  return Math.max(35,Math.round((DUEL_BASE_POWER[car.catalogId]||140)*integrity*mileageFactor*tune));
}
async function getOpenStreetDuel(){
  const p=db();if(!p)return null;const pool=await p;
  const r=await pool.query("SELECT * FROM autonomous_street_duels WHERE status='open' ORDER BY created_at DESC LIMIT 1");
  return r.rows[0]||null;
}
async function getStreetDuelForPlayer(chat){
  const p=db();if(!p)return null;const pool=await p;
  const r=await pool.query("SELECT * FROM autonomous_street_duels WHERE challenger_chat_id=$1 OR opponent_chat_id=$1 ORDER BY created_at DESC LIMIT 1",[String(chat)]);
  return r.rows[0]||null;
}
function streetDuelText(duel,chat){
  if(!duel)return "🏁 УЛИЧНЫЕ ДУЭЛИ\n\nПока нет открытых вызовов. Создай вызов из своего гаража и дождись соперника.";
  if(duel.status==="open"){
    const own=String(duel.challenger_chat_id)===String(chat);
    return ["🏁 УЛИЧНЫЙ ВЫЗОВ №"+duel.id,"","👤 Вызов: "+duel.challenger_name,"🚘 Автомобиль: "+duel.challenger_car.model,"🔢 Госномер: "+(duel.challenger_car?.plate||"не указан"),"⚡ Мощность: "+duel.challenger_power+" ед.","💰 Ставка: "+fmt(duel.stake),"","⏳ "+(own?"Ожидаем соперника. Взнос уже списан.":"Прими вызов своим лучшим автомобилем.")].join("\n");
  }
  if(duel.status==="cancelled")return "🏁 ВЫЗОВ №"+duel.id+" ОТМЕНЁН\n\nСтавка 50 000 ₽ возвращена создателю.";
  const r=duel.result||{};
  return ["🏁 РЕЗУЛЬТАТ ДУЭЛИ №"+duel.id,"","🚘 "+(duel.challenger_name||"Игрок 1")+": "+(duel.challenger_car?.model||"—")+" · "+(duel.challenger_power||0)+" ед.","🔢 Госномер: "+(duel.challenger_car?.plate||"не указан"),"🚘 "+(duel.opponent_name||"Игрок 2")+": "+(duel.opponent_car?.model||"—")+" · "+(duel.opponent_power||0)+" ед.","🔢 Госномер: "+(duel.opponent_car?.plate||"не указан"),"","🏆 Победитель: "+(r.winnerName||"Ничья"),"⚡ Разница мощности: "+(r.powerDifference||0)+" ед.","💰 Выплата: "+fmt(r.payout||0),"🏦 Комиссия: "+fmt(r.fee||0)].join("\n");
}
function streetDuelKeyboard(duel,chat,state){
  const aiRow=(state?.garage||[]).length?[[{text:"🤖 Сразиться с ИИ · "+fmt(STREET_DUEL_STAKE),callback_data:"ag:duel_ai"}]]:[];
  if(duel?.status==="open")return {inline_keyboard:[
    ...(String(duel.challenger_chat_id)!==String(chat)?[[{text:"🏁 Принять вызов · "+fmt(duel.stake),callback_data:"ag:duel_join:"+duel.id}]]:[]),
    ...(String(duel.challenger_chat_id)===String(chat)?[[{text:"❌ Отменить вызов и вернуть ставку",callback_data:"ag:duel_cancel:"+duel.id}]]:[]),
    ...aiRow,
    [{text:"🔄 Обновить",callback_data:"ag:duel"}],[{text:"⬅️ Главное меню",callback_data:"ag:home"}]
  ]};
  const rows=(state?.garage||[]).map(c=>[{text:"🚘 Вызвать: "+c.model+" · "+fmt(STREET_DUEL_STAKE),callback_data:"ag:duel_create:"+c.id}]);
  return {inline_keyboard:[...aiRow,...rows,[{text:"🔄 Обновить",callback_data:"ag:duel"}],[{text:"⬅️ Главное меню",callback_data:"ag:home"}]]};
}
async function createStreetDuel(chat,name,carId){
  const p=db();if(!p)throw new Error("DATABASE_URL не настроен");const pool=await p;const client=await pool.connect();
  try{
    await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(834721906)");
    const active=await client.query("SELECT id FROM autonomous_street_duels WHERE status='open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE");
    if(active.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"exists",duel:await getOpenStreetDuel()};}
    const pr=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    if(!pr.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    const state=pr.rows[0].state;ensureVehiclePlates(state);
    const car=(state.garage||[]).find(x=>String(x.id)===String(carId));
    if(!car){await client.query("ROLLBACK");return {ok:false,reason:"car"};}
    if(Number(state.player?.balance||0)<STREET_DUEL_STAKE){await client.query("ROLLBACK");return {ok:false,reason:"money"};}
    const power=streetDuelPower(car);
    addTx(state,"street_duel_entry",-STREET_DUEL_STAKE,"Взнос в уличную дуэль");
    const r=await client.query("INSERT INTO autonomous_street_duels(status,challenger_chat_id,challenger_name,challenger_car,challenger_power,stake) VALUES('open',$1,$2,$3::jsonb,$4,$5) RETURNING *",[String(chat),String(name||"Перекуп"),JSON.stringify(car),power,STREET_DUEL_STAKE]);
    state.transactions[0].description="Взнос в уличную дуэль №"+r.rows[0].id;
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(state)]);
    await client.query("COMMIT");return {ok:true,duel:r.rows[0]};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}

async function cancelStreetDuel(chat,duelId){
  const p=db();if(!p)throw new Error("DATABASE_URL не настроен");const pool=await p;const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const dr=await client.query("SELECT * FROM autonomous_street_duels WHERE id=$1 AND status='open' FOR UPDATE",[Number(duelId)]);
    if(!dr.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"closed"};}
    const duel=dr.rows[0];
    if(String(duel.challenger_chat_id)!==String(chat)){await client.query("ROLLBACK");return {ok:false,reason:"owner"};}
    const pr=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    if(!pr.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    const state=pr.rows[0].state;
    addTx(state,"street_duel_refund",Number(duel.stake),"Возврат ставки за отмену дуэли №"+duel.id);
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(state)]);
    const upd=await client.query("UPDATE autonomous_street_duels SET status='cancelled',result=$2::jsonb,finished_at=now() WHERE id=$1 RETURNING *",[duel.id,JSON.stringify({winnerName:"Вызов отменён",payout:Number(duel.stake),fee:0})]);
    await client.query("COMMIT");return {ok:true,duel:upd.rows[0]};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}
async function joinStreetDuel(chat,name,duelId){
  const p=db();if(!p)throw new Error("DATABASE_URL не настроен");const pool=await p;const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const dr=await client.query("SELECT * FROM autonomous_street_duels WHERE id=$1 AND status='open' FOR UPDATE",[Number(duelId)]);
    if(!dr.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"closed"};}
    const duel=dr.rows[0];
    if(String(duel.challenger_chat_id)===String(chat)){await client.query("ROLLBACK");return {ok:false,reason:"self"};}
    const ids=[String(duel.challenger_chat_id),String(chat)].sort();
    const pr=await client.query("SELECT chat_id,state FROM autonomous_game_state WHERE chat_id=ANY($1::text[]) ORDER BY chat_id FOR UPDATE",[ids]);
    const states=new Map(pr.rows.map(x=>[String(x.chat_id),x.state]));
    const challenger=states.get(String(duel.challenger_chat_id)),opponent=states.get(String(chat));
    if(!challenger||!opponent){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    ensureVehiclePlates(challenger);ensureVehiclePlates(opponent);
    if(!Array.isArray(opponent.garage)||!opponent.garage.length){await client.query("ROLLBACK");return {ok:false,reason:"no_car"};}
    if(Number(opponent.player?.balance||0)<Number(duel.stake)){await client.query("ROLLBACK");return {ok:false,reason:"money"};}
    const opponentCar=opponent.garage.slice().sort((a,b)=>streetDuelPower(b)-streetDuelPower(a))[0];
    const opponentPower=streetDuelPower(opponentCar);
    addTx(opponent,"street_duel_entry",-Number(duel.stake),"Взнос в уличную дуэль №"+duel.id);
    const challengerPower=Number(duel.challenger_power)||streetDuelPower(duel.challenger_car);
    const challengerRoll=challengerPower*(0.96+Math.random()*0.08),opponentRoll=opponentPower*(0.96+Math.random()*0.08);
    const draw=Math.abs(challengerRoll-opponentRoll)<0.75;
    const winnerChat=draw?null:(challengerRoll>opponentRoll?String(duel.challenger_chat_id):String(chat));
    const pot=Number(duel.stake)*2,fee=draw?0:Math.round(pot*0.05),payout=draw?Number(duel.stake):pot-fee;
    let winnerName="Ничья";
    if(draw){
      addTx(challenger,"street_duel_refund",Number(duel.stake),"Возврат ставки за ничью в дуэли №"+duel.id);
      addTx(opponent,"street_duel_refund",Number(duel.stake),"Возврат ставки за ничью в дуэли №"+duel.id);
    }else if(winnerChat===String(duel.challenger_chat_id)){
      winnerName=duel.challenger_name;addTx(challenger,"street_duel_prize",payout,"Победа в уличной дуэли №"+duel.id);
    }else{
      winnerName=String(name||"Соперник");addTx(opponent,"street_duel_prize",payout,"Победа в уличной дуэли №"+duel.id);
    }
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(duel.challenger_chat_id),JSON.stringify(challenger)]);
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(opponent)]);
    const result={winnerChat,winnerName,payout,fee,powerDifference:Math.abs(Number(duel.challenger_power||0)-Number(opponentPower||0)),challengerRoll:Math.round(challengerRoll),opponentRoll:Math.round(opponentRoll),draw};
    const upd=await client.query("UPDATE autonomous_street_duels SET status='finished',opponent_chat_id=$2,opponent_name=$3,opponent_car=$4::jsonb,opponent_power=$5,result=$6::jsonb,finished_at=now() WHERE id=$1 RETURNING *",[duel.id,String(chat),String(name||"Соперник"),JSON.stringify(opponentCar),opponentPower,JSON.stringify(result)]);
    await client.query("COMMIT");return {ok:true,duel:upd.rows[0],result};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}
async function createStreetDuelAI(chat,name,callbackId){
  const p=db();if(!p)throw new Error("DATABASE_URL не настроен");const pool=await p;const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const pr=await client.query("SELECT state FROM autonomous_game_state WHERE chat_id=$1 FOR UPDATE",[String(chat)]);
    if(!pr.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"no_profile"};}
    const state=pr.rows[0].state;
    ensureVehiclePlates(state);
    state.processedCallbacks=Array.isArray(state.processedCallbacks)?state.processedCallbacks:[];
    if(callbackId&&state.processedCallbacks.includes(String(callbackId))){await client.query("ROLLBACK");return {ok:false,reason:"duplicate"};}
    if(!Array.isArray(state.garage)||!state.garage.length){await client.query("ROLLBACK");return {ok:false,reason:"no_car"};}
    if(Number(state.player?.balance||0)<STREET_DUEL_STAKE){await client.query("ROLLBACK");return {ok:false,reason:"money"};}
    const playerCar=state.garage.slice().sort((a,b)=>streetDuelPower(b)-streetDuelPower(a))[0];
    const playerPower=streetDuelPower(playerCar);
    const eligibleAiCars=CATALOG.filter(car=>car.id!==playerCar.catalogId);
    const base=eligibleAiCars.sort((a,b)=>Math.abs((DUEL_BASE_POWER[a.id]||140)-playerPower)-Math.abs((DUEL_BASE_POWER[b.id]||140)-playerPower))[0];
    const opponentCar={
      id:"ai_"+Date.now(),catalogId:base.id,model:base.name,year:base.year,
      plate:createUniqueVehiclePlate(state),
      mileage:50000+Math.floor(Math.random()*130000),condition:82+Math.floor(Math.random()*19),
      status:"ai",aiOpponent:true
    };
    const opponentPower=Math.max(35,Math.round(playerPower*(0.92+Math.random()*0.16)));
    addTx(state,"street_duel_entry",-STREET_DUEL_STAKE,"Взнос в дуэль с ИИ");
    const playerRoll=playerPower*(0.96+Math.random()*0.08);
    const aiRoll=opponentPower*(0.96+Math.random()*0.08);
    const draw=Math.abs(playerRoll-aiRoll)<0.75;
    const playerWon=!draw&&playerRoll>aiRoll;
    const payout=draw?STREET_DUEL_STAKE:playerWon?Math.round(STREET_DUEL_STAKE*1.9):0;
    const fee=playerWon?STREET_DUEL_STAKE*2-payout:0;
    if(draw)addTx(state,"street_duel_refund",STREET_DUEL_STAKE,"Возврат ставки за ничью с ИИ");
    else if(playerWon)addTx(state,"street_duel_prize",payout,"Победа над ИИ в уличной дуэли");
    const result={
      mode:"ai",winnerChat:draw?null:playerWon?String(chat):"autoflip-ai",
      winnerName:draw?"Ничья":playerWon?String(name||"Перекуп"):"AUTOFLIP ИИ",
      payout,fee,powerDifference:Math.abs(Number(playerPower||0)-Number(opponentPower||0)),
      challengerRoll:Math.round(playerRoll),opponentRoll:Math.round(aiRoll),draw
    };
    const duel=await client.query(
      "INSERT INTO autonomous_street_duels(status,challenger_chat_id,challenger_name,challenger_car,challenger_power,opponent_name,opponent_car,opponent_power,stake,result,finished_at) VALUES('finished',$1,$2,$3::jsonb,$4,'AUTOFLIP ИИ',$5::jsonb,$6,$7,$8::jsonb,now()) RETURNING *",
      [String(chat),String(name||"Перекуп"),JSON.stringify(playerCar),playerPower,JSON.stringify(opponentCar),opponentPower,STREET_DUEL_STAKE,JSON.stringify(result)]
    );
    await client.query("UPDATE autonomous_game_state SET state=$2::jsonb,updated_at=now() WHERE chat_id=$1",[String(chat),JSON.stringify(state)]);
    await client.query("COMMIT");
    return {ok:true,duel:duel.rows[0],result};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}

function containerText(state) {
  const parts=Array.isArray(state.player.containerParts)?state.player.containerParts:[];
  return ["📦 КОНТЕЙНЕРНЫЙ ТЕРМИНАЛ","","Открывай контейнеры с запчастями и находками.","Каждый контейнер содержит случайную награду: деньги, детали или редкий приз.","","💰 Баланс: "+fmt(state.player.balance),"🧩 Деталей на складе: "+parts.length,...(parts.length?["","СКЛАД ДЕТАЛЕЙ",...parts.slice(0,8).map((p,i)=>(i+1)+". "+p.name+" · "+p.condition+"% · оценка "+fmt(p.value))]:[])].join("\n");
}
function containerKeyboard(state) {
  const parts=Array.isArray(state.player.containerParts)?state.player.containerParts:[];
  return {inline_keyboard:[
    [{text:"📦 Стандартный · 150 000 ₽",callback_data:"ag:crate_open:standard"}],
    [{text:"🏎 Спортивный · 400 000 ₽",callback_data:"ag:crate_open:sport"}],
    [{text:"💎 Элитный · 900 000 ₽",callback_data:"ag:crate_open:elite"}],
    ...parts.slice(0,8).map(p=>[{text:"💰 Продать "+p.name+" · "+fmt(Math.max(1000,Math.round((Number(p.value)||0)*(Number(p.condition)||50)/100/1000)*1000)),callback_data:"ag:part_sell:"+p.id}]),
    [{text:"⬅️ Главное меню",callback_data:"ag:home"}]
  ]};
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

function parsePurchaseOfferInput(value) {
  // Принимаем любую положительную целую сумму: 1, 10, 100, 1000, 10000,
  // а также запись с пробелами/символом рубля, например "10 000 ₽".
  const raw=String(value??"").trim();
  const normalized=raw.replace(/[\s₽]/g,"");
  if(!/^\d+$/.test(normalized))return null;
  const offer=Number(normalized);
  if(!Number.isSafeInteger(offer)||offer<=0)return null;
  return offer;
}

function negotiatePurchase(state,id,requestedOffer) {
  const c=state.market.find(x=>x.id===id); if(!c)return {ok:false,reason:"missing"};
  const offer=parsePurchaseOfferInput(requestedOffer);
  if(offer===null)return {ok:false,reason:"invalid_offer"};
  if(offer>c.buyPrice)return {ok:false,reason:"too_high"};
  const pressure=Math.max(.05,Math.min(.75,(c.marketPressure||.5)*.55)), roll=rng(state);
  // Продавец никогда не принимает абсурдно низкие предложения: минимум 70% от цены лота.
  // Вместо согласия он выставляет встречную цену, близкую к заявленной стоимости.
  const minimumAcceptable=Math.ceil(c.buyPrice*.70);
  if(offer<minimumAcceptable){
    const counter=Math.round(c.buyPrice*(.975+rng(state)*.025)/1000)*1000;
    state.pendingPurchase={carId:id,offer,result:"counter",counter,finalPrice:counter};
    return {ok:true,result:"counter",offer,counter,finalPrice:counter};
  }
  if(roll>pressure){state.pendingPurchase={carId:id,offer,result:"accepted",finalPrice:offer};return {ok:true,result:"accepted",offer,finalPrice:offer};}
  if(roll>pressure*.55){const counter=Math.round(c.buyPrice*(.975+rng(state)*.025)/1000)*1000;state.pendingPurchase={carId:id,offer,result:"counter",counter,finalPrice:counter};return {ok:true,result:"counter",offer,counter,finalPrice:counter};}
  state.pendingPurchase={carId:id,offer,result:"rejected"};return {ok:true,result:"rejected",offer};
}
function purchaseListing(state, id) {
  const c=state.market.find(x=>x.id===id);
  if(c&&c.expiresAtTurn!=null&&c.expiresAtTurn<=(Number(state.meta.turn)||0)){state.market=state.market.filter(x=>x.id!==id);refreshMarket(state);state.pendingPurchase=null;return {ok:false,reason:"expired"};}
  if(!c)return {ok:false,reason:"missing"}; if(state.garage.length>=state.player.garageCapacity)return {ok:false,reason:"garage_full"};
  const n=state.pendingPurchase&&state.pendingPurchase.carId===id?state.pendingPurchase:null;
  if(n?.result==="rejected")return {ok:false,reason:"seller_rejected"};
  const price=n?.finalPrice||c.buyPrice; if(state.player.balance<price)return {ok:false,reason:"no_money"};
  c.status="owned";c.buyPrice=price;c.repairSpent=0;c.extraSpent=0;
  const hiddenPenalty=Math.min(3,Number(c.hiddenDefects)||0);
  if(hiddenPenalty){c.damage=Math.min(10,(c.damage||0)+hiddenPenalty);c.condition=Math.max(55,(c.condition||0)-hiddenPenalty*4);c.repairCost=Math.round(c.repairCost*(1+hiddenPenalty*.12));c.risk=Math.min(.8,c.risk+hiddenPenalty*.06);}
  c.hiddenDefects=0;c.hiddenDefectSeverity=0;sandbox.buildCar(c);state.garage.push(c);state.market=state.market.filter(x=>x.id!==id);state.pendingPurchase=null;
  addTx(state,"buy",-price,"Покупка "+c.model);return {ok:true,car:c,price};
}


function buyPlate(state, id) {
  refreshPlates(state);
  const p=state.plateMarket.find(x=>x.id===id);
  if(!p)return {ok:false,reason:"missing"};
  if(state.player.balance<p.buyPrice)return {ok:false,reason:"no_money",cost:p.buyPrice};
  addTx(state,"plate_buy",-p.buyPrice,"Покупка номера "+p.plate);
  state.plateWarehouse.push({id:p.id,plate:p.plate,quality:p.quality,rarity:p.rarity,cost:p.buyPrice});
  state.plateMarket=state.plateMarket.filter(x=>x.id!==id);
  return {ok:true,plate:p};
}

function sellPlate(state, id) {
  const p=state.plateWarehouse.find(x=>x.id===id);
  if(!p)return {ok:false,reason:"missing"};
  const demand=0.85+(Math.sin((state.meta.day||1)+p.quality)*0.12);
  const offer=Math.round((p.cost*(1.02+demand*0.32))/1000)*1000;
  const profit=offer-p.cost;
  addTx(state,"plate_sale",offer,"Продажа номера "+p.plate);
  state.plateWarehouse=state.plateWarehouse.filter(x=>x.id!==id);
  return {ok:true,plate:p,offer,profit};
}

function repairVehicle(state, id) {
  const c=state.garage.find(x=>x.id===id);
  if(!c)return {ok:false,reason:"missing"};
  if((c.damage||0)<=0 && (c.condition||0)>=100)return {ok:false,reason:"restored"};
  const remaining=Math.max(1,Number(c.damage)||1);
  const cost=Math.round(Math.min(c.repairCost,Math.max(12000,c.repairCost*(remaining/7))));
  if(state.player.balance<cost)return {ok:false,reason:"no_money",cost};
  c.repairSpent=(c.repairSpent||0)+cost;
  c.condition=Math.min(100,c.condition+Math.max(8,Math.min(22,Math.round(remaining*3.5))));
  c.damage=Math.max(0,c.damage-Math.max(1,Math.ceil(remaining/2)));
  addTx(state,"repair",-cost,"Ремонт "+c.model);
  return {ok:true,car:c,cost};
}

function prepareVehicle(state, id) {
  const c=state.garage.find(x=>x.id===id);
  if(!c)return {ok:false,reason:"missing"};
  const cost=Math.round(18000+Math.max(0,c.damage)*2500);
  if(state.player.balance<cost)return {ok:false,reason:"no_money",cost};
  c.extraSpent=(c.extraSpent||0)+cost;
  c.condition=Math.min(100,c.condition+6);
  c.targetSale=Math.round(c.targetSale*1.035);
  addTx(state,"prep",-cost,"Подготовка "+c.model);
  return {ok:true,car:c,cost};
}

function acceptPendingSale(state, id) {
  const c=state.garage.find(x=>x.id===id);
  if(!c)return {ok:false,reason:"missing"};
  if(!state.pendingDeal || state.pendingDeal.carId!==id)return {ok:false,reason:"stale"};
  const buyerName=state.pendingDeal.buyerType||"Покупатель";
  const offer=Number(state.pendingDeal.amount)||0;
  const cost=vehicleCost(c);
  const profit=offer-cost;
  if(profit<0){state.pendingDeal=null;return {ok:false,reason:"loss",profit};}
  state.pendingDeal=null;
  state.player.respect+=profit>100000?2:1;
  const progress=addProgress(state,profit);
  state.garage=state.garage.filter(x=>x.id!==id);
  addTx(state,"sale",offer,"Продажа "+c.model+" (прибыль "+fmt(profit)+")");
  const balanceBeforeContracts=state.player.balance;
  updateContracts(state,profit);
  const contractReward=state.player.balance-balanceBeforeContracts;
  return {ok:true,car:c,buyerName,offer,profit,progress,contractReward};
}

async function send(sendFn,chat,text,markup) {
  return sendFn(chat,text,markup?{reply_markup:markup}:undefined);
}
async function screen(sendFn,chat,state,text,markup) {
  const keyboard=markup||menu();
  const body=String(text||"");
  const photos=carPhotoEntriesFromText(body);
  if(photos.length>1) {
    try {
      for(const item of photos) {
        const label="🚘 "+item.car.name+" · "+item.car.year;
        await sendFn(chat,label,{photo_url:item.url});
      }
      return await sendFn(chat,body,{reply_markup:keyboard});
    } catch(e) {
      console.log("CAR PHOTOS SEND ERROR:",e?.message||e);
      return send(sendFn,chat,body,keyboard);
    }
  }
  const photo=photos[0]?.url || carPhotoFromState(state,body);
  if(photo) {
    if(body.length<=1024) {
      try { return await sendFn(chat,body,{photo_url:photo,reply_markup:keyboard}); } catch(e) {
        console.log("CAR PHOTO SEND ERROR:",e?.message||e);
      }
    } else {
      try {
        await sendFn(chat,"",{photo_url:photo});
        return await sendFn(chat,body,{reply_markup:keyboard});
      } catch(e) {
        console.log("CAR PHOTO LONG SEND ERROR:",e?.message||e);
      }
    }
  }
  return send(sendFn,chat,body,keyboard);
}

async function open(chat, firstName, sendFn) {
  const state=await load(chat,firstName);
  return screen(sendFn,chat,state,mainText(state),menu());
}

async function leaderboardText(chat) {
  const p=db();
  if(!p) return "🏆 РЕЙТИНГ ИГРОКОВ\\n\\nБаза данных пока недоступна.";
  const pool=await p;
  const result=await pool.query(`
    WITH ranked AS (
      SELECT
        gs.chat_id,
        COALESCE(NULLIF(gs.state->'player'->>'name',''),'Перекуп') AS name,
        COALESCE(NULLIF(gs.state->'player'->>'level','')::integer,1) AS level,
        COALESCE(NULLIF(gs.state->'player'->>'balance','')::numeric,0) AS balance,
        COALESCE(NULLIF(gs.state->'player'->>'respect','')::integer,0) AS respect,
        (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(gs.state->'transactions','[]'::jsonb)) tx WHERE tx->>'kind'='sale') AS sales,
        COALESCE((SELECT SUM(COALESCE(NULLIF(tx->>'profit','')::numeric,0)) FROM jsonb_array_elements(COALESCE(gs.state->'transactions','[]'::jsonb)) tx WHERE tx->>'kind'='sale'),0) AS profit
      FROM autonomous_game_state gs
      WHERE gs.state ? 'player'
    )
    SELECT *, ROW_NUMBER() OVER (ORDER BY balance DESC, level DESC, respect DESC) AS place
    FROM ranked
    ORDER BY balance DESC, level DESC, respect DESC
  `);
  const rows=result.rows||[];
  if(!rows.length) return "🏆 РЕЙТИНГ ИГРОКОВ\\n\\nПока никто не начал карьеру.";
  const top=rows.slice(0,10);
  const lines=top.map((r,i)=>
    (i+1)+". "+String(r.name||"Перекуп").slice(0,24)+" · ур. "+r.level+
    "\\n   💰 "+fmt(r.balance)+" · 🤝 "+r.sales+" продаж · ⭐ "+r.respect
  );
  const own=rows.find(r=>String(r.chat_id)===String(chat));
  lines.push("");
  if(own && Number(own.place)>10) lines.push("Твоё место: №"+own.place+" · "+fmt(own.balance));
  else if(own) lines.push("Ты в первой десятке — место №"+own.place+".");
  lines.push("Всего игроков: "+rows.length);
  return "🏆 РЕЙТИНГ ИГРОКОВ\\n\\n"+lines.join("\\n");
}

async function streetDuelChampionshipText(chat){
  const p=db();
  if(!p)return "🏆 ЧЕМПИОНАТ AUTOFLIP\\n\\nБаза данных пока недоступна.";
  const pool=await p;
  const result=await pool.query(`
    WITH finished AS (
      SELECT *, result->>'winnerChat' AS winner_chat,
        COALESCE((result->>'draw')::boolean,false) AS is_draw,
        COALESCE((result->>'payout')::numeric,0) AS payout_amount
      FROM autonomous_street_duels
      WHERE status='finished'\n        AND finished_at >= (date_trunc('month',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')\n        AND finished_at < ((date_trunc('month',now() AT TIME ZONE 'Europe/Moscow') + interval '1 month') AT TIME ZONE 'Europe/Moscow')
    ),
    participants AS (
      SELECT challenger_chat_id AS chat_id,challenger_name AS name,is_draw,
        (winner_chat=challenger_chat_id) AS won,
        (NOT is_draw AND winner_chat IS DISTINCT FROM challenger_chat_id) AS lost,
        CASE WHEN is_draw THEN 0 WHEN winner_chat=challenger_chat_id THEN payout_amount-stake ELSE -stake END AS net
      FROM finished
      UNION ALL
      SELECT opponent_chat_id AS chat_id,opponent_name AS name,is_draw,
        (winner_chat=opponent_chat_id) AS won,
        (NOT is_draw AND winner_chat IS DISTINCT FROM opponent_chat_id) AS lost,
        CASE WHEN is_draw THEN 0 WHEN winner_chat=opponent_chat_id THEN payout_amount-stake ELSE -stake END AS net
      FROM finished WHERE opponent_chat_id IS NOT NULL
    ),
    ranked AS (
      SELECT chat_id,MAX(name) AS name,COUNT(*)::integer AS duels,
        SUM(won::integer)::integer AS wins,SUM(lost::integer)::integer AS losses,
        SUM(is_draw::integer)::integer AS draws,SUM(net)::bigint AS net_profit,
        ROW_NUMBER() OVER(ORDER BY SUM(won::integer) DESC,SUM(net) DESC,COUNT(*) DESC,MAX(name)) AS place
      FROM participants GROUP BY chat_id
    )
    SELECT * FROM ranked ORDER BY place
  `);
  const rows=result.rows||[];
  const month=new Intl.DateTimeFormat("ru-RU",{month:"long",year:"numeric",timeZone:"Europe/Moscow"}).format(new Date());
  if(!rows.length)return "🏆 ЧЕМПИОНАТ AUTOFLIP\\nСезон: "+month+"\\n\\nПока в этом месяце не было дуэлей. Создай вызов и начни борьбу за первое место!";
  const lines=rows.slice(0,10).map(r=>
    (r.place<=3?["🥇","🥈","🥉"][Number(r.place)-1]:String(r.place)+".")+" "+String(r.name||"Перекуп").slice(0,22)+
    "\\n   🏁 "+r.wins+" побед · "+r.losses+" поражений · "+r.draws+" ничьих"+
    "\\n   📈 "+(Number(r.net_profit)>=0?"+":"")+fmt(r.net_profit)
  );
  const own=rows.find(r=>String(r.chat_id)===String(chat));
  lines.push("");
  if(own)lines.push("Твоя позиция: №"+own.place+" · "+own.wins+" побед · "+(Number(own.net_profit)>=0?"+":"")+fmt(own.net_profit));
  else lines.push("Ты ещё не участвовал в дуэлях этого сезона.");
  lines.push("Участников сезона: "+rows.length);
  return "🏆 ЧЕМПИОНАТ AUTOFLIP\\nСезон: "+month+"\\n\\n"+lines.join("\\n");
}
async function handleText(chat,text,firstName,sendFn) {
  const raw=String(text||"").trim();
  if(raw!=="/perekup" && raw!=="🎮 Автономная игра" && raw!=="🚗 Симулятор Перекупа"){
    const parsedOffer=parsePurchaseOfferInput(raw);
    if(parsedOffer!==null){
      const state=await load(chat,firstName);
      const pending=state.pendingPurchase;
      // Не теряем режим торга из-за старого/неполного состояния:
      // если для чата есть активный автомобиль торга, любое новое число
      // считается новым предложением, пока сделка не завершена/отменена.
      if(pending?.carId && (pending.awaitingOffer || pending.result==="counter")){
        const offer=parsedOffer;
        const run=await withState(chat,firstName,s=>{
          if(!s.pendingPurchase?.carId || s.pendingPurchase.carId!==pending.carId)return {ok:false,reason:"stale"};
          const r=negotiatePurchase(s,pending.carId,offer);
          if(r.ok)s.pendingPurchase={...s.pendingPurchase,...r,offer,awaitingOffer:false};
          return r;
        });
        if(!run || !run.result || run.result.duplicate){
          await sendFn(chat,"⚠️ Торг уже обрабатывается или устарел. Открой «Осмотр» и попробуй ещё раз.",{reply_markup:{inline_keyboard:[[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+pending.carId}]]}});
          return true;
        }
        const result=run.result;
        const liveState=run.state;
        const car=liveState?.market?.find(x=>x.id===pending.carId);
        if(!car){
          await sendFn(chat,"⚠️ Лот уже недоступен. Вернись на рынок.",{reply_markup:{inline_keyboard:[[{text:"🛒 Рынок",callback_data:"ag:market"}]]}});
          return true;
        }
        if(!Number.isFinite(Number(result.offer)) || Number(result.offer)!==offer){
          await sendFn(chat,"⚠️ Цена предложения не была сохранена. Повтори торг ещё раз.",{reply_markup:{inline_keyboard:[[{text:"💬 Торговаться снова",callback_data:"ag:offer:"+car.id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+car.id}]]}});
          return true;
        }
        if(result.reason==="invalid_offer" || result.reason==="too_high"){
          await sendFn(chat,"⚠️ Некорректная цена.\n\nВведи любую целую сумму больше 0 и не выше цены продавца: "+fmt(car.buyPrice),{reply_markup:{inline_keyboard:[[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+car.id}]]}});
          return true;
        }
        if(result.result==="rejected"){
          await sendFn(chat,"❌ ПРОДАВЕЦ ОТКАЗАЛСЯ\n\nТвоё предложение: "+fmt(result.offer)+"\nЦена остаётся "+fmt(car.buyPrice)+".",{reply_markup:{inline_keyboard:[[{text:"💬 Попробовать снова",callback_data:"ag:offer:"+car.id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+car.id}]]}});
          return true;
        }
        const temp={pendingPurchase:result};
        await sendFn(chat,purchaseOfferText(temp,car),{reply_markup:{inline_keyboard:result.result==="counter"?[[{text:"🤝 Принять "+fmt(result.counter),callback_data:"ag:buy:"+car.id}],[{text:"💬 Торговаться снова",callback_data:"ag:offer:"+car.id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+car.id}]]:[[ {text:"💳 Купить за "+fmt(result.finalPrice),callback_data:"ag:buy:"+car.id}],[{text:"💬 Торговаться снова",callback_data:"ag:offer:"+car.id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+car.id}]]}});
        return true;
      }
    }
    return false;
  }
  await open(chat,firstName,sendFn);
  return true;
}

async function handleCallback(chat,data,firstName,sendFn,answerFn,callbackId) {
  if(!String(data).startsWith("ag:")) return false;
  const [_,action,id]=String(data).split(":");
  if(action==="duel"){ 
    const duel=await getOpenStreetDuel(),state=await load(chat,firstName);
    const shown=duel||await getStreetDuelForPlayer(chat);
    await screen(sendFn,chat,state,streetDuelText(shown,chat),streetDuelKeyboard(shown,chat,state));return true;
  }
  if(action==="duel_ai"){
    const result=await createStreetDuelAI(chat,firstName,callbackId),state=await load(chat,firstName);
    const openDuel=await getOpenStreetDuel();
    const messages={no_profile:"Сначала открой игру командой /start.",no_car:"В гараже нет автомобиля для гонки. Сначала купи машину.",money:"Для дуэли с ИИ нужно 50 000 ₽.",duplicate:"Эта дуэль уже обработана. Открой раздел дуэлей ещё раз."};
    const text=result.ok?streetDuelText(result.duel,chat):"⚠️ "+(messages[result.reason]||"Не удалось начать дуэль с ИИ.");
    await screen(sendFn,chat,state,text,streetDuelKeyboard(openDuel,chat,state));return true;
  }
  if(action==="duel_create"){
    const result=await createStreetDuel(chat,firstName,id),duel=result.duel||await getOpenStreetDuel(),state=await load(chat,firstName);
    const messages={exists:"Уже есть открытый вызов. Дождись его завершения.",no_profile:"Сначала открой игру командой /start.",car:"Эта машина уже не в гараже.",money:"Для вызова нужно 50 000 ₽."};
    await sendFn(chat,result.ok?"🏁 Вызов создан! 50 000 ₽ списаны и зарезервированы.":"⚠️ "+(messages[result.reason]||"Не удалось создать вызов."),{reply_markup:streetDuelKeyboard(duel,chat,state)});return true;
  }
  if(action==="duel_cancel"){
    const result=await cancelStreetDuel(chat,id),state=await load(chat,firstName);
    const duel=result.duel||await getOpenStreetDuel()||await getStreetDuelForPlayer(chat);
    const message=result.ok?"✅ Вызов отменён. Ставка 50 000 ₽ возвращена.":(result.reason==="owner"?"⚠️ Отменить вызов может только его создатель.":"⚠️ Этот вызов уже закрыт.");
    await sendFn(chat,message,{reply_markup:streetDuelKeyboard(duel,chat,state)});return true;
  }
  if(action==="duel_join"){
    const result=await joinStreetDuel(chat,firstName,id),state=await load(chat,firstName);
    const duel=result.duel||await getOpenStreetDuel()||await getStreetDuelForPlayer(chat);
    const messages={closed:"Этот вызов уже завершён.",self:"Нельзя принять собственный вызов.",no_profile:"Сначала открой игру командой /start.",no_car:"В гараже нет автомобиля для гонки.",money:"Недостаточно денег для ставки 50 000 ₽."};
    await screen(sendFn,chat,state,result.ok?streetDuelText(result.duel,chat):"⚠️ "+(messages[result.reason]||"Не удалось принять вызов."),streetDuelKeyboard(duel,chat,state));return true;
  }
  if(action==="battle"||action==="battle_results"){
    const battle=action==="battle_results"?await containerBattleForPlayer(chat):await getContainerBattle();
    await sendFn(chat,battleText(battle,chat),{reply_markup:battleKeyboard(battle,chat)});
    return true;
  }
  if(action==="battle_create"){
    const result=await createContainerBattle(chat,firstName);
    const battle=result.battle||await getContainerBattle();
    await sendFn(chat,result.ok?"✅ Комната создана. Приглашай других игроков!": "⚠️ Уже есть открытая комната. Можно присоединиться к ней.",{reply_markup:battleKeyboard(battle,chat)});
    return true;
  }
  if(action==="battle_join"){
    const result=await joinContainerBattle(chat,firstName,id);
    const battle=result.battle||await getContainerBattle();
    const messages={closed:"Комната уже закрыта.",joined:"Ты уже участник этой комнаты.",full:"В комнате уже 10 участников.",other_room:"Ты уже записан в другую открытую битву.",no_profile:"Сначала открой игру командой /start.",money:"Недостаточно денег для взноса."};
    await sendFn(chat,result.ok?"⚔️ Ты вступил в битву! Взнос 100 000 ₽ списан.": "⚠️ "+(messages[result.reason]||"Не удалось вступить."),{reply_markup:battleKeyboard(battle,chat)});
    return true;
  }
  if(action==="battle_start"){
    const result=await startContainerBattle(chat,id);
    if(!result.ok){
      const msg={closed:"Комната уже закрыта.",owner:"Начать битву может только создатель комнаты.",few:"Нужно минимум 2 участника."};
      const battle=await getContainerBattle();
      await sendFn(chat,"⚠️ "+(msg[result.reason]||"Не удалось начать битву."),{reply_markup:battleKeyboard(battle,chat)});
      return true;
    }
    await sendFn(chat,battleText(result.battle,chat),{reply_markup:battleKeyboard(result.battle,chat)});
    return true;
  }

  try { await answerFn?.(); } catch {}
  if(action==="home"){await open(chat,firstName,sendFn);return true;}
  if(action==="championship"){
    try {
      const text=await streetDuelChampionshipText(chat);
      await sendFn(chat,text,{reply_markup:menu()});
    } catch(e) {
      console.log("CHAMPIONSHIP ERROR:",e?.stack||e?.message||e);
      await sendFn(chat,"⚠️ Не удалось загрузить чемпионат. Попробуй ещё раз.",{reply_markup:menu()});
    }
    return true;
  }
  if(action==="leaderboard"){
    try {
      const text=await leaderboardText(chat);
      await sendFn(chat,text,{reply_markup:menu()});
    } catch(e) {
      console.log("LEADERBOARD ERROR:",e?.stack||e?.message||e);
      await sendFn(chat,"⚠️ Не удалось загрузить рейтинг. Попробуй ещё раз.",{reply_markup:menu()});
    }
    return true;
  }
  const run=await withState(chat,firstName,state=>{
    const advancesTurn = new Set(["refresh","diagnose","diagnose_deep","offer","buy","repair","prep","sell","negotiate","reject","accept","plate_refresh","platebuy","platesell","pmrefresh","pmbuy","borrow","repay","rollback","crate_open","part_sell"]).has(action);
    if(advancesTurn) state.meta.turn=(Number(state.meta.turn)||0)+1;
    if(callbackId) {
      state.processedCallbacks.push(String(callbackId));
      state.processedCallbacks=state.processedCallbacks.slice(-100);
    }
    if(action==="refresh"){
      const removed=[], sorted=[...state.market].sort((x,y)=>(x.currentDemand??x.demand)-(y.currentDemand??y.demand));
      for(const car of sorted.slice(0,2)){state.market=state.market.filter(x=>x.id!==car.id);removed.push(car.model);}
      refreshMarket(state);state.meta.day=Math.floor((Number(state.meta.turn)||0)/6)+1;
      const note=removed.length?"\n\n🔄 С рынка ушли: "+removed.join(", ")+".":"";
      const pressure=(state.meta.competitionLevel||0)>75?"\n⚠️ Конкуренты давят: хорошие лоты долго не лежат.":"";
      return {text:mainText(state)+note+pressure,markup:marketKeyboard(state)};
    }
    if(action==="market") return {text:"🚗 РЫНОК\n\nВыбирай лот для полного осмотра.",markup:marketKeyboard(state)};
    if(action==="finance") return {text:financeText(state),markup:financeKeyboard(state)};
    if(action==="containers") return {text:containerText(state),markup:containerKeyboard(state)};
    if(action==="borrow"){
      const amount=Number(id)||0, debt=Math.max(0,Number(state.player.debt)||0);
      if(![500000,1000000,3000000,5000000,10000000,25000000,50000000].includes(amount) || debt+amount>50000000)
        return {text:"⚠️ Сумма недоступна. Максимальный долг — 50 000 000 ₽.",markup:financeKeyboard(state)};
      if(debt>0)
        return {text:"⚠️ Сначала погаси текущий кредит.",markup:financeKeyboard(state)};
      state.player.debt=debt+Math.round(amount*1.15);
      state.player.loanDueDay=(Number(state.meta.day)||1)+30;
      addTx(state,"loan",amount,"Кредит банка");
      return {text:"✅ КРЕДИТ ОДОБРЕН\n\nПолучено: "+fmt(amount)+"\nК возврату: "+fmt(state.player.debt)+"\nСрок: до дня "+state.player.loanDueDay+"\nКомиссия 15% включена в долг.",markup:financeKeyboard(state)};
    }
    if(action==="repay"){
      const debt=Math.max(0,Number(state.player.debt)||0);
      if(!debt)return {text:"✅ Долгов нет.",markup:financeKeyboard(state)};
      if(Number(state.player.balance)<debt)return {text:"❌ Недостаточно средств для полного погашения.\nДолг: "+fmt(debt)+"\nБаланс: "+fmt(state.player.balance),markup:financeKeyboard(state)};
      addTx(state,"loan_repay",-debt,"Полное погашение кредита");
      state.player.debt=0;state.player.loanDueDay=0;
      return {text:"✅ КРЕДИТ ПОГАШЕН\n\nДолг закрыт полностью.",markup:financeKeyboard(state)};
    }
    if(action==="rollback"){
      const car=state.garage.find(x=>String(x.id)===String(id));
      if(!car)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      if(car.mileageRolledBack)return {text:"⚠️ Пробег уже корректировался.",markup:carKeyboard(car)};
      const original=Math.max(0,Number(car.mileage)||0), cost=25000;
      if(original<30000)return {text:"⚠️ На таком пробеге корректировка недоступна.",markup:carKeyboard(car)};
      if(Number(state.player.balance)<cost)return {text:"❌ Недостаточно денег. Нужно "+fmt(cost)+".",markup:carKeyboard(car)};
      const reduction=Math.min(original-10000,Math.round(original*(0.18+0.12*rng(state))/1000)*1000);
      addTx(state,"mileage_rollback",-cost,"Корректировка одометра: "+car.model);
      car.originalMileage=original;car.mileage=Math.max(10000,original-reduction);
      car.mileageRolledBack=true;car.odometerRisk=0.24;
      car.targetSale=Math.round(car.targetSale*1.08);
      return {text:"🌀 ОДОМЕТР ИЗМЕНЁН\n\n"+car.model+"\nБыло: "+original.toLocaleString("ru-RU")+" км\nСтало: "+car.mileage.toLocaleString("ru-RU")+" км\nРасход: "+fmt(cost)+"\nПотенциальная цена продажи выросла на 8%.\n\n⚠️ Покупатель может проверить историю и снизить предложение.",markup:carKeyboard(car)};
    }
    if(action==="garage") return {text:state.garage.length?("🏠 ГАРАЖ\n\n"+state.garage.map((c,i)=>(i+1)+". "+c.model+" · "+fmt(vehicleCost(c))).join("\n")):"🏠 ГАРАЖ\n\nПока пусто.",markup:garageKeyboard(state)};
    if(action==="day"){
      const event=state.meta.marketEvent||{title:"Спокойный рынок",text:"Стабильный спрос."};
      return {text:"📅 СЕГОДНЯ\n\nДень "+(state.meta.day||1)+"\n📈 "+event.title+"\n"+event.text+"\n\n👥 Конкурентов: "+(state.meta.competitors||1)+"\n⚠️ Давление: "+(state.meta.competitionLevel||0)+"%\n\nРынок меняется. Хороший лот может исчезнуть после обновления.",markup:menu()};
    }
    if(action==="inspect"){
      const c=state.market.find(x=>x.id===id); if(!c)return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      state.pendingPurchase=null; return {text:inspectText(c,state),markup:inspectKeyboard(c,state)};
    }
    if(action==="offer"){
      const c=state.market.find(x=>x.id===id); if(!c)return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      state.pendingPurchase={carId:id,awaitingOffer:false};
      const quick=[70,80,90].map(percent=>[{text:"💬 Предложить "+percent+"% · "+fmt(Math.floor(c.buyPrice*percent/100/1000)*1000),callback_data:"ag:offer"+percent+":"+id}]);
      return {text:"💬 ТОРГ С ПРОДАВЦОМ\n\n🚘 "+c.model+"\n💵 Цена продавца: "+fmt(c.buyPrice)+"\n\nВыбери готовое предложение кнопкой — вводить сумму не нужно. Чем ниже цена, тем выше риск отказа.\n\nИли введи свою сумму вручную.",markup:{inline_keyboard:[...quick,[{text:"⌨️ Ввести свою сумму",callback_data:"ag:offer_custom:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
    }
    if(action==="offer_custom"){
      const c=state.market.find(x=>x.id===id); if(!c)return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      state.pendingPurchase={carId:id,awaitingOffer:true};
      return {text:"⌨️ ВВОД СВОЕЙ ЦЕНЫ\n\n🚘 "+c.model+"\n💵 Цена продавца: "+fmt(c.buyPrice)+"\n\nВведи сумму в рублях одним сообщением. Например: 1250000.\nЦена должна быть больше 0 и не выше цены продавца.",markup:{inline_keyboard:[[{text:"⬅️ Назад к кнопкам",callback_data:"ag:offer:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
    }
    if(["offer70","offer80","offer90"].includes(action)){
      const c=state.market.find(x=>x.id===id); if(!c)return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      const percent=Number(action.slice(5));
      const offer=Math.max(1,Math.floor(c.buyPrice*percent/100/1000)*1000);
      const result=negotiatePurchase(state,id,offer);
      if(!result.ok)return {text:"⚠️ Не удалось отправить предложение. Попробуй ещё раз.",markup:{inline_keyboard:[[{text:"💬 Повторить торг",callback_data:"ag:offer:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
      if(result.result==="rejected")return {text:"❌ ПРОДАВЕЦ ОТКАЗАЛСЯ\n\nТвоё предложение: "+fmt(result.offer)+"\nЦена продавца остаётся "+fmt(c.buyPrice)+".",markup:{inline_keyboard:[[{text:"💬 Другое предложение",callback_data:"ag:offer:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
      const temp={pendingPurchase:result};
      return {text:purchaseOfferText(temp,c),markup:result.result==="counter"?{inline_keyboard:[[{text:"🤝 Принять "+fmt(result.counter),callback_data:"ag:buy:"+id}],[{text:"💬 Другое предложение",callback_data:"ag:offer:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}:{inline_keyboard:[[{text:"💳 Купить за "+fmt(result.finalPrice),callback_data:"ag:buy:"+id}],[{text:"💬 Другое предложение",callback_data:"ag:offer:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
    }
    if(action==="submit_offer"){
      const c=state.market.find(x=>x.id===id); if(!c)return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      const result=negotiatePurchase(state,id,state.pendingPurchase?.offer);
      if(result.result==="rejected")return {text:"❌ ПРОДАВЕЦ ОТКАЗАЛСЯ\n\nТвоё предложение: "+fmt(result.offer)+"\nЦена остаётся "+fmt(c.buyPrice)+".",markup:inspectKeyboard(c,state)};
      if(result.result==="counter")return {text:purchaseOfferText(state,c),markup:{inline_keyboard:[[{text:"🤝 Принять "+fmt(result.counter),callback_data:"ag:buy:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
      return {text:purchaseOfferText(state,c),markup:{inline_keyboard:[[{text:"💳 Купить за "+fmt(result.finalPrice),callback_data:"ag:buy:"+id}],[{text:"⬅️ Осмотр",callback_data:"ag:inspect:"+id}]]}};
    }
    if(action==="diagnose" || action==="diagnose_deep"){
      const c=state.market.find(x=>x.id===id);
      if(!c) return {text:"⚠️ Лот уже исчез с рынка.",markup:marketKeyboard(state)};
      const deep=action==="diagnose_deep";
      const result=runDiagnostic(state,c,deep);
      if(!result.ok) return {text:"❌ Не хватает денег на диагностику.\n\nНужно: "+fmt(result.cost),markup:inspectKeyboard(c,state)};
      const detail = deep
        ? "Все скрытые дефекты проверены до покупки."
        : (result.found ? "Обнаружен скрытый дефект. Осторожно: часть риска ещё может остаться." : "На быстрой проверке новый дефект не найден.");
      return {text:(deep?"🔬 ГЛУБОКАЯ ДИАГНОСТИКА":"🔎 БЫСТРАЯ ДИАГНОСТИКА")+"\n\n"+detail+"\n💵 Расход: "+fmt(result.cost)+"\n\n"+inspectText(c,state),markup:inspectKeyboard(c,state)};
    }
    if(action==="buy"){
      const result=purchaseListing(state,id);
      if(!result.ok){
        if(result.reason==="expired") return {text:"⏳ Лот уже ушёл с рынка. Конкуренты успели раньше.",markup:marketKeyboard(state)};
        if(result.reason==="missing") return {text:"⚠️ Лот уже продан.",markup:marketKeyboard(state)};
        if(result.reason==="garage_full") return {text:"⚠️ Гараж заполнен.",markup:garageKeyboard(state)};
        if(result.reason==="seller_rejected") return {text:"❌ Продавец отказался.\n\nВернись к осмотру и реши, брать ли машину по полной цене.",markup:marketKeyboard(state)};
        return {text:"❌ Недостаточно денег.",markup:marketKeyboard(state)};
      }
      const c=result.car;
      return {text:"✅ ПОКУПКА ОФОРМЛЕНА\n\n"+c.model+"\n💵 Потрачено: "+fmt(result.price)+"\n💰 Остаток: "+fmt(state.player.balance)+"\n\nТеперь начинается работа с машиной.",markup:carKeyboard(c)};
    }
    const rawId=String(id||"");
    const carId=rawId.split("|")[0];
    const c=state.garage.find(x=>String(x.id)===String(carId));
    if(!c && ["car","repair","prep","sell"].includes(action))return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
    if(action==="pmrefresh"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      sandbox.buildCar(c);
      sandbox.refreshPartMarket(c,Date.now());
      return {text:sandboxMarketText(c),markup:sandboxMarketKeyboard(c)};
    }
    if(action==="pmsrc"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const source=bits[1];
      const known=sandbox.PART_SOURCES.some(x=>x.id===source);
      if(!known)return {text:"⚠️ Источник рынка не найден.",markup:sandboxMarketKeyboard(c)};
      return {text:sandboxMarketText(c,{source}),markup:sandboxMarketKeyboard(c,{source})};
    }
    if(action==="pmbuy"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const offer=sandbox.getPartMarketOffer(c,bits[1]);
      if(!offer)return {text:"⚠️ Лот уже продан или исчез с рынка.",markup:sandboxMarketKeyboard(c)};
      const result=sandbox.buyPartMarketOffer(c,offer.id,state.player.balance);
      if(!result.ok){
        return {text:"❌ ПОКУПКА ДЕТАЛИ НЕ ВЫПОЛНЕНА\n\n"+(result.reason==="insufficient_funds"?"Недостаточно денег.\nНужно: "+fmt(result.price)+" ₽\nБаланс: "+fmt(result.available)+" ₽":"Лот недоступен."),markup:sandboxMarketKeyboard(c)};
      }
      addTx(state,"part_purchase",-result.cost,"Покупка детали: "+result.part.name+" ("+offer.sourceTitle+")");
      return {text:"✅ ДЕТАЛЬ КУПЛЕНА\n\n"+result.part.name+"\nИсточник: "+offer.sourceTitle+"\nСостояние: "+result.part.condition+"%\nЦена: "+fmt(result.cost)+" ₽\n\n📦 Деталь находится на складе.",markup:sandboxWarehouseKeyboard(c,state)};
    }
    if(action==="warehouse"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      sandbox.buildCar(c);
      return {text:sandboxWarehouseText(c),markup:sandboxWarehouseKeyboard(c,state)};
    }
    if(action==="winfo"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const item=sandbox.warehouseItem(c,bits[1]);
      if(!item)return {text:"⚠️ Деталь уже отсутствует на складе.",markup:sandboxWarehouseKeyboard(c,state)};
      return {text:sandboxWarehouseInfo(c,item),markup:sandboxWarehouseKeyboard(c,state)};
    }
    if(action==="winstall"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const item=sandbox.warehouseItem(c,bits[1]);
      if(!item)return {text:"⚠️ Деталь уже отсутствует на складе.",markup:sandboxWarehouseKeyboard(c,state)};
      const result=sandbox.installWarehousePart(c,bits[1]);
      if(!result.ok){
        const reasons={warehouse_missing:"Деталь уже отсутствует на складе.",no_matching_slot:"В автомобиле нет свободного места для этой детали.",incompatible:"Деталь несовместима с целевым узлом.",dependencies_missing:"Для установки сначала должны быть установлены зависимые узлы.",fasteners_not_ready:"Крепёж целевого узла не готов."};
        const extra=result.compatibility?.details? "\n\n"+result.compatibility.details:"";
        return {text:"⚠️ УСТАНОВКА ЗАБЛОКИРОВАНА\n\n"+(reasons[result.reason]||"Операция невозможна.")+extra,markup:sandboxWarehouseKeyboard(c,state)};
      }
      return {text:"✅ ДОНорская ДЕТАЛЬ УСТАНОВЛЕНА\n\n"+sandboxPartText(result.part)+"\n\n📜 Происхождение сохранено: VIN донора "+(result.provenance?.sourceVin||"—")+"\nСерийный номер: "+(result.part.serial||"—"),markup:sandboxPartKeyboard(c,result.part)};
    }
    if(action==="wsell"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const result=sandbox.sellWarehousePart(c,bits[1]);
      if(!result.ok)return {text:"⚠️ Деталь уже отсутствует на складе.",markup:sandboxWarehouseKeyboard(c,state)};
      if(result.revenue)addTx(state,"sandbox_warehouse_sell",result.revenue,"Продажа складской детали: "+result.part.name);
      return {text:"💰 ДЕТАЛЬ ПРОДАНА\n\n"+result.part.name+"\nПолучено: "+fmt(result.revenue)+" ₽\n\nПроисхождение детали сохранено в истории автомобиля.",markup:sandboxWarehouseKeyboard(c,state)};
    }
    if(action==="donor"){
      if(!c)return {text:"⚠️ Целевой автомобиль уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      const donor=state.garage.find(x=>String(x.id)===String(bits[1]));
      if(!donor)return {text:"⚠️ Автомобиль-донор не найден.",markup:sandboxWarehouseKeyboard(c,state)};
      sandbox.buildCar(c); sandbox.buildCar(donor);
      return {text:"🚘 АВТОМОБИЛЬ-ДОНОР\n\n"+donor.model+"\nVIN: "+donor.sandbox.vin+"\n\nВыбери установленную деталь. Она будет снята и передана на склад целевого автомобиля.",markup:sandboxDonorKeyboard(c,donor)};
    }
    if(action==="extract"){
      if(!c)return {text:"⚠️ Целевой автомобиль уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      const donor=state.garage.find(x=>String(x.id)===String(bits[1]));
      if(!donor)return {text:"⚠️ Донор не найден.",markup:sandboxWarehouseKeyboard(c,state)};
      sandbox.buildCar(c); sandbox.buildCar(donor);
      const source=sandbox.getPart(donor,bits[2]);
      if(!source)return {text:"⚠️ Деталь донора не найдена.",markup:sandboxDonorKeyboard(c,donor)};
      const target=c.sandbox.parts.find(p=>p.name===source.name&&!p.installed);
      if(!target){
        return {text:"⚠️ На целевом автомобиле нет снятого одноимённого узла для установки.",markup:sandboxDonorKeyboard(c,donor)};
      }
      const check=sandbox.compatibility(source,target);
      if(!check.ok){
        return {text:"❌ НЕСОВМЕСТИМО\n\n"+check.details+"\nБаллы совместимости: "+Math.round(check.score*100)+"%.",markup:sandboxDonorKeyboard(c,donor)};
      }
      const extracted=sandbox.donorExtract(donor,source.id);
      if(!extracted.ok)return {text:"⚠️ Снять деталь не удалось: "+extracted.reason,markup:sandboxDonorKeyboard(c,donor)};
      const moved=sandbox.transferWarehousePart(donor,c,extracted.part.id);
      if(!moved.ok)return {text:"⚠️ Деталь снята и осталась на складе донора. Передача не выполнена: "+moved.reason,markup:sandboxWarehouseKeyboard(c,state)};
      return {text:"📦 ДЕТАЛЬ ПЕРЕДАНА НА СКЛАД\n\n"+moved.part.name+"\nСостояние: "+moved.part.condition+"%\nVIN донора: "+(moved.part.provenance?.sourceVin||donor.sandbox.vin)+"\nСерийный номер: "+moved.part.serial+"\n\nТеперь её можно установить или продать.",markup:sandboxWarehouseKeyboard(c,state)};
    }
    if(action==="diag"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const level=Math.max(1,Math.min(6,Number(bits[1])||1));
      const spec=sandbox.INSPECTION_LEVELS[level-1];
      if(spec.cost && Number(state.player.balance)<spec.cost){
        return {text:"❌ Недостаточно денег.\n\nНужно: "+fmt(spec.cost)+"\nБаланс: "+fmt(state.player.balance),markup:carKeyboard(c)};
      }
      const result=sandbox.inspectCar(c,level);
      if(result.cost) addTx(state,"diagnostic",-result.cost,"Диагностика уровня "+level+": "+spec.title);
      const next=level<6?level+1:6;
      const lines=["🔎 ДИАГНОСТИКА "+level+"/6","",spec.title,"⏱ Время: "+result.time+" ч","💵 Стоимость: "+fmt(result.cost),""];
      if(level===1) lines.push("Визуально осмотрены кузов и колёса.");
      if(level===2) lines.push("Проверены основные электронные и силовые системы.");
      if(level>=3) lines.push("Доступны состояния отдельных деталей и узлов.");
      if(level>=4) lines.push("⚠️ Скрытых повреждений выявлено: "+result.hiddenDamage);
      if(level>=5) lines.push("⚖️ Юридический риск: "+(result.legalRisk?"обнаружен":"не обнаружен")+"\n🧾 Деталей с сохранённым происхождением: "+result.provenanceCount);
      if(level>=6) lines.push("🔩 Повреждённых крепёжных элементов: "+result.damagedFasteners);
      return {text:lines.join("\n"),markup:{inline_keyboard:[
        ...(level<6?[[{text:"🔬 Следующий уровень · "+fmt(sandbox.INSPECTION_LEVELS[next-1].cost),callback_data:"ag:diag:"+c.id+"|"+next}]]:[]),
        [{text:"🧩 Детали",callback_data:"ag:parts:"+c.id}],
        [{text:"⬅️ Машина",callback_data:"ag:car:"+c.id}]
      ]}};
    }
    if(action==="parts"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      sandbox.buildCar(c);
      return {text:sandboxText(c),markup:sandboxSystemsKeyboard(c)};
    }
    if(action==="system"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      const systemId=bits[1];
      sandbox.buildCar(c);
      if(String(systemId).startsWith("group_")){
        const group=carDetailGroup(String(systemId).slice(6));
        if(!group)return {text:"⚠️ Раздел не найден.",markup:sandboxSystemsKeyboard(c)};
        const parts=sandboxGroupParts(c,group);
        return {
          text:group.icon+" "+group.title+"\n\nДеталей: "+parts.length+"\nСреднее состояние: "+sandboxGroupAverage(parts)+"%",
          markup:sandboxGroupKeyboard(c,group.id)
        };
      }
      const sys=sandbox.SYSTEMS.find(x=>x.id===systemId);
      if(!sys)return {text:"⚠️ Система не найдена.",markup:sandboxSystemsKeyboard(c)};
      return {text:"⚙️ "+sys.title+"\n\nВыбери узел/сборку.",markup:sandboxAssembliesKeyboard(c,systemId)};
    }
    if(action==="assembly"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const assemblyId=bits[1], systemId=bits[2];
      const assemblies=sandbox.listAssemblies(c,systemId);
      const a=assemblies.find(x=>x.id===assemblyId);
      if(!a)return {text:"⚠️ Узел не найден.",markup:sandboxSystemsKeyboard(c)};
      return {text:"🔧 "+a.title+"\n\nДеталей: "+a.parts+"\nСреднее состояние: "+a.averageCondition+"%\nКрепежа: "+a.fasteners+"\nНе установлено: "+a.missingFasteners,markup:sandboxPartsKeyboard(c,systemId)};
    }
    if(action==="part"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const part=sandbox.getPart(c,bits[1]);
      if(!part)return {text:"⚠️ Деталь не найдена.",markup:sandboxSystemsKeyboard(c)};
      return {text:sandboxPartText(part),markup:sandboxPartKeyboard(c,part)};
    }
    if(action==="fasteners"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const part=sandbox.getPart(c,bits[1]);
      if(!part)return {text:"⚠️ Деталь не найдена.",markup:sandboxSystemsKeyboard(c)};
      return {text:sandboxPartText(part)+"\n\n🧷 КРЕПЁЖ\n"+sandbox.fastenerSummary(part).installed+"/"+sandbox.fastenerSummary(part).total+" установлено",markup:sandboxFastenersKeyboard(c,part)};
    }
    if(action==="fa"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      sandbox.buildCar(c);
      const result=sandbox.actionFastener(c,bits[1],bits[2],bits[3]);
      const part=sandbox.getPart(c,bits[2]);
      if(!result.ok)return {text:"⚠️ "+(result.reason==="already_removed"?"Крепёж уже снят.":result.reason==="already_installed"?"Крепёж уже установлен.":result.reason==="remove_first"?"Сначала сними крепёж.":"Операция с крепежом невозможна."),markup:sandboxFastenersKeyboard(c,part)};
      if(result.cost)addTx(state,"sandbox_fastener_"+bits[1],-result.cost,"Крепёж");
      if(result.revenue)addTx(state,"sandbox_fastener_sell",result.revenue,"Продажа крепежа");
      return {text:"✅ Крепёж обработан.\n\n"+sandboxFastenerText(result.fastener),markup:sandboxFastenersKeyboard(c,part)};
    }
    if(action==="pa"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      const part=sandbox.getPart(c,bits[1]);
      const op=bits[2];
      if(!part)return {text:"⚠️ Деталь не найдена.",markup:sandboxSystemsKeyboard(c)};
      const result=sandbox.actionPart(c,op,part.id);
      if(!result.ok){
        const reasons={part_removed:"Деталь уже снята.",remove_first:"Сначала сними деталь с автомобиля.",part_missing:"Деталь не найдена.",unknown_action:"Операция неизвестна."};
        return {text:"⚠️ "+(reasons[result.reason]||"Операция невозможна."),markup:sandboxPartKeyboard(c,part)};
      }
      if(result.cost)addTx(state,"sandbox_"+op,-result.cost,op+" "+part.name);
      if(result.revenue)addTx(state,"sandbox_"+op,result.revenue,op+" "+part.name);
      return {text:"✅ ОПЕРАЦИЯ ВЫПОЛНЕНА\n\n"+sandboxPartText(part)+"\n\n⏱ Время: "+result.time+" ч"+(result.warning?"\n⚠️ История зафиксировала вмешательство.":""),markup:sandboxPartKeyboard(c,part)};
    }
    if(action==="global"){
      if(!c)return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      const bits=String(id||"").split("|");
      const op=bits[1];
      const result=sandbox.applyGlobalAction(c,op);
      if(!result.ok)return {text:"⚠️ Операция невозможна.",markup:sandboxSystemsKeyboard(c)};
      if(result.cost)addTx(state,"sandbox_"+op,-result.cost,"Глобальная операция: "+op);
      return {text:"🛠 ГЛОБАЛЬНАЯ ОПЕРАЦИЯ\n\nОперация: "+op+"\n⏱ Время: "+result.time+" ч\n💵 Расход: "+fmt(result.cost||0),markup:sandboxSystemsKeyboard(c)};
    }
    if(action==="car")return {text:carText(c),markup:carKeyboard(c)};
    if(action==="repair"){
      const result=repairVehicle(state,id);
      if(!result.ok){
        if(result.reason==="restored") return {text:"🛠 Машина уже восстановлена. Дополнительный ремонт не нужен.",markup:carKeyboard(c)};
        if(result.reason==="no_money") return {text:"❌ Не хватает денег на ремонт.",markup:carKeyboard(c)};
        return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      }
      return {text:"🔧 РЕМОНТ ЗАВЕРШЁН\n\n"+carText(result.car),markup:carKeyboard(result.car)};
    }
    if(action==="prep"){
      const result=prepareVehicle(state,id);
      if(!result.ok){
        if(result.reason==="no_money") return {text:"❌ Не хватает денег на подготовку.",markup:carKeyboard(c)};
        return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
      }
      return {text:"✨ ПОДГОТОВКА ЗАВЕРШЕНА\n\n"+carText(result.car),markup:carKeyboard(result.car)};
    }
    if(action==="sell"){
      if(state.pendingDeal) return {text:"🤝 Сначала заверши текущие переговоры.",markup:dealKeyboard(c,state.pendingDeal)};
      const deal=buyerOfferDetails(state,c);
      const event=dealRisk(state,c);
      if(event.type==="incident") deal.amount=Math.max(1000,deal.amount-event.penalty);
      if(event.type==="bonus") deal.amount+=event.bonus;
      deal.carId=c.id;
      deal.event=event.type;
      deal.eventText=event.text||"";
      deal.eventPenalty=Number(event.penalty)||0;
      deal.eventBonus=Number(event.bonus)||0;
      deal.negotiations=0;
      state.pendingDeal=deal;
      return {text:dealText(state,c,deal),markup:dealKeyboard(c,deal)};
    }
    if(action==="negotiate"){
      if(!state.pendingDeal || state.pendingDeal.carId!==id) return {text:"⚠️ Предложение устарело. Запроси новое.",markup:carKeyboard(c)};
      const result=negotiation(state,c,state.pendingDeal);
      if(result.left){state.pendingDeal=null;return {text:"❌ ПОКУПАТЕЛЬ УШЁЛ\n\n"+result.text,markup:carKeyboard(c)};}
      state.pendingDeal.negotiations=(Number(state.pendingDeal.negotiations)||0)+1;
      state.pendingDeal.amount=result.amount;
      return {text:"💬 ТОРГ\n\n"+result.text+"\n\n"+dealText(state,c,state.pendingDeal),markup:dealKeyboard(c,state.pendingDeal)};
    }
    if(action==="reject"){
      if(state.pendingDeal?.carId===id) state.pendingDeal=null;
      return {text:"❌ СДЕЛКА ОТМЕНЕНА\n\nМашина осталась в гараже.",markup:carKeyboard(c)};
    }
    if(action==="accept"){
      const result=acceptPendingSale(state,id);
      if(!result.ok){
        if(result.reason==="missing") return {text:"⚠️ Машина уже не в гараже.",markup:garageKeyboard(state)};
        if(result.reason==="stale") return {text:"⚠️ Предложение устарело. Нажми «Продать» заново.",markup:carKeyboard(c)};
        return {text:"🛑 ПРОДАЖА ЗАБЛОКИРОВАНА\n\nПредложение ниже себестоимости.\nМашина осталась в гараже.",markup:carKeyboard(c)};
      }
      const levelText=result.progress.levelUps ? "\n⬆️ Новый уровень: "+state.player.level : "";
      const contractText=result.contractReward ? "\n🎁 Награда контракта: "+fmt(result.contractReward) : "";
      return {text:"💰 МАШИНА ПРОДАНА\n\n"+result.car.model+"\n👤 Покупатель: "+result.buyerName+"\n💵 Получено: "+fmt(result.offer)+"\n📈 Прибыль: "+fmt(result.profit)+"\n⭐ XP: +"+result.progress.gainedXp+levelText+contractText+"\n💰 Баланс: "+fmt(state.player.balance),markup:garageKeyboard(state)};
    }
    if(action==="contracts")return {text:"📋 КОНТРАКТЫ\n\n"+state.contracts.map(c=>(c.completed?"✅ ":"⏳ ")+c.title+"\n   "+c.goal+"\n   Прогресс: "+(typeof c.progress==="number"? (c.id==="profit_300k"?fmt(c.progress):c.progress)+"/"+(c.id==="profit_300k"?fmt(c.target):c.target):"—")+"\n   Награда: "+fmt(c.reward)).join("\n\n"),markup:menu()};
    if(action==="plates"){
      refreshPlates(state);
      return {
        text:"🔢 НОМЕРА\n\n"+(state.plateWarehouse.length ? "📦 Склад:\n"+state.plateWarehouse.map((p,i)=>(i+1)+". "+p.plate+" · "+fmt(p.cost)).join("\n") : "📦 Склад пуст.")+
          "\n\n🏷 Торги:\n"+state.plateMarket.map((p,i)=>(i+1)+". "+p.plate+" · "+fmt(p.buyPrice)+" · редкость "+p.quality+"%").join("\n"),
        markup:{inline_keyboard:[
          ...state.plateMarket.map((p,i)=>[{text:"🏷 Купить "+p.plate+" · "+fmt(p.buyPrice),callback_data:"ag:platebuy:"+p.id}]),
          ...state.plateWarehouse.map(p=>[{text:"💰 Продать "+p.plate,callback_data:"ag:platesell:"+p.id}]),
          [{text:"🔄 Обновить торги",callback_data:"ag:plate_refresh"}],
          [{text:"⬅️ Меню",callback_data:"ag:home"}]
        ]}
      };
    }
    if(action==="plate_refresh"){
      state.plateMarket=[]; refreshPlates(state);
      return {text:"🏷 Новая волна торгов номерами.",markup:{inline_keyboard:[
        [{text:"🔢 Открыть номера",callback_data:"ag:plates"}],
        [{text:"⬅️ Меню",callback_data:"ag:home"}]
      ]}};
    }
    if(action==="platebuy"){
      const result=buyPlate(state,id);
      if(!result.ok){
        if(result.reason==="missing") return {text:"⚠️ Лот номера уже недоступен.",markup:{inline_keyboard:[[{text:"🔢 Номера",callback_data:"ag:plates"}]]}};
        return {text:"❌ Не хватает денег.",markup:{inline_keyboard:[[{text:"🔢 Номера",callback_data:"ag:plates"}]]}};
      }
      return {text:"✅ НОМЕР ПРИОБРЕТЁН\n\n"+result.plate.plate+"\n💵 Цена: "+fmt(result.plate.buyPrice),markup:{inline_keyboard:[[{text:"🔢 Номера",callback_data:"ag:plates"}],[{text:"⬅️ Меню",callback_data:"ag:home"}]]}};
    }
    if(action==="platesell"){
      const result=sellPlate(state,id);
      if(!result.ok)return {text:"⚠️ Номер уже продан.",markup:{inline_keyboard:[[{text:"🔢 Номера",callback_data:"ag:plates"}]]}};
      return {text:"💰 НОМЕР ПРОДАН\n\n"+result.plate.plate+"\n💵 Получено: "+fmt(result.offer)+"\n📈 Прибыль: "+fmt(result.profit),markup:{inline_keyboard:[[{text:"🔢 Номера",callback_data:"ag:plates"}],[{text:"⬅️ Меню",callback_data:"ag:home"}]]}};
    }
    if(action==="part_sell"){
      const parts=Array.isArray(state.player.containerParts)?state.player.containerParts:[];
      const index=parts.findIndex(x=>String(x.id)===String(id));
      if(index<0)return {text:"⚠️ Деталь уже отсутствует на складе.",markup:containerKeyboard(state)};
      const part=parts[index];
      const revenue=Math.max(1000,Math.round((Number(part.value)||0)*(Number(part.condition)||50)/100/1000)*1000);
      parts.splice(index,1); addTx(state,"container_part_sale",revenue,"Продажа контейнерной детали: "+part.name);
      return {text:"💰 ДЕТАЛЬ ПРОДАНА\n\n"+part.name+"\nСостояние: "+part.condition+"%\nПолучено: "+fmt(revenue),markup:containerKeyboard(state)};
    }
    if(action==="crate_open"){
      const crates={standard:{name:"Стандартный",price:150000},sport:{name:"Спортивный",price:400000},elite:{name:"Элитный",price:900000}};
      const crate=crates[id];
      if(!crate)return {text:"⚠️ Контейнер не найден.",markup:containerKeyboard(state)};
      if(Number(state.player.balance)<crate.price)return {text:"❌ Недостаточно денег.\nНужно: "+fmt(crate.price)+"\nБаланс: "+fmt(state.player.balance),markup:containerKeyboard(state)};
      addTx(state,"container_open",-crate.price,"Открытие контейнера: "+crate.name);
      const roll=rng(state), names=["Турбина","Спортивный блок двигателя","Комплект подвески","Тормозная система","Карбоновые элементы","Коробка передач"];
      if(roll<0.38){
        const reward=Math.round(crate.price*(0.35+rng(state)*0.85)/1000)*1000;
        addTx(state,"container_cash",reward,"Денежная находка из контейнера");
        return {text:"📦 КОНТЕЙНЕР ОТКРЫТ\n\n💵 Внутри наличные: "+fmt(reward)+"\nСтоимость контейнера: "+fmt(crate.price)+"\nРезультат: "+fmt(reward-crate.price),markup:containerKeyboard(state)};
      }
      if(roll<0.88){
        const part={id:"loot_"+Date.now().toString(36)+"_"+Math.floor(rng(state)*1e6).toString(36),name:names[Math.floor(rng(state)*names.length)],condition:Math.round(55+rng(state)*44),quality:Math.round(45+rng(state)*54),value:Math.round(crate.price*(0.65+rng(state)*1.1)/1000)*1000};
        state.player.containerParts=Array.isArray(state.player.containerParts)?state.player.containerParts:[];
        state.player.containerParts.unshift(part); state.player.containerParts=state.player.containerParts.slice(0,40);
        return {text:"📦 КОНТЕЙНЕР ОТКРЫТ\n\n🧩 Найдена деталь: "+part.name+"\nСостояние: "+part.condition+"% · качество: "+part.quality+"%\nОценка рынка: "+fmt(part.value)+"\n\nДеталь отправлена на склад. Её можно продать или сохранить для будущих проектов.",markup:containerKeyboard(state)};
      }
      if(roll<0.97){
        const reward=Math.round(crate.price*(1.25+rng(state)*1.6)/1000)*1000;
        addTx(state,"container_cash",reward,"Редкая находка из контейнера");
        return {text:"✨ РЕДКАЯ НАХОДКА!\n\nВ контейнере обнаружен ценный лот.\n💰 Получено: "+fmt(reward)+"\nЧистый результат: "+fmt(reward-crate.price),markup:containerKeyboard(state)};
      }
      const jackpot=Math.round(crate.price*(3+rng(state)*3)/1000)*1000;
      addTx(state,"container_jackpot",jackpot,"Главный приз контейнера");
      return {text:"🏆 ДЖЕКПОТ КОНТЕЙНЕРА!\n\n💰 Главный приз: "+fmt(jackpot)+"\nЧистый результат: "+fmt(jackpot-crate.price),markup:containerKeyboard(state)};
    }
    if(action==="stats")return {text:statsText(state),markup:menu()};
    return {text:mainText(state),markup:menu()};
  }, callbackId);
  if(run.result?.duplicate) {
    await screen(sendFn,chat,run.state,"↩️ Это действие уже было обработано.\n\nСостояние игры не изменилось.",menu());
    return true;
  }
  await screen(sendFn,chat,run.state,run.result.text,run.result.markup);
  return true;
}

module.exports={init,load,save,open,handleText,handleCallback,leaderboardText,CATALOG,CAR_PHOTOS,BUYER_TYPES,newState,refreshMarket,createListing,createUniqueVehiclePlate,ensureVehiclePlates,addTx,scoreListing,bestDeal,recommendation,addProgress,updateContracts,buyerOffer,buyerOfferDetails,buyerProfile,negotiation,dealRisk,runDiagnostic,vehicleCost,purchaseListing,repairVehicle,prepareVehicle,buyPlate,sellPlate,acceptPendingSale,parsePurchaseOfferInput,negotiatePurchase,streetDuelPower,STREET_DUEL_STAKE};
