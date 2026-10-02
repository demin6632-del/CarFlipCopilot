const { Client } = require("pg");
let dbPromise=null;
const RENEWAL_COST=1500;
const PLATE_REMOVAL_COST=55000;
const PLATE_AUCTION_COMMISSION=0.10;

function num(v){
  if(v==null)return null;
  const n=Number(String(v).replace(/[^0-9.-]/g,""));
  return Number.isFinite(n)?n:null;
}
function norm(v){return String(v||"").toLowerCase().replace(/ё/g,"е");}
function vehicleInfo(state){
  const v=state?.vehicle||{};
  const name=String(v.name||"").trim();
  const plate=String(state?.plate||"").trim();
  if(!name&&!plate)return null;
  const key=(name+"|"+plate).toLowerCase().replace(/\s+/g," ").trim();
  return {key,name:name||null,plate:plate||null};
}
function vehicleCostValue(state){
  const v=state?.vehicle||{};
  return num(v.invested??v.cost_basis??v.cost??state?.invested);
}
async function db(){
  if(!process.env.DATABASE_URL)return null;
  if(!dbPromise)dbPromise=(async()=>{
    const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
    await c.connect();
    await c.query("CREATE TABLE IF NOT EXISTS game_economy_transactions (id bigserial PRIMARY KEY,chat_id text NOT NULL,action text,kind text NOT NULL,amount numeric NOT NULL,balance_before numeric,balance_after numeric,screen_text text NOT NULL,vehicle_key text,fee numeric NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now())");
    await c.query("ALTER TABLE game_economy_transactions ADD COLUMN IF NOT EXISTS vehicle_key text");
    await c.query("ALTER TABLE game_economy_transactions ADD COLUMN IF NOT EXISTS fee numeric NOT NULL DEFAULT 0");
    await c.query("CREATE INDEX IF NOT EXISTS game_economy_chat_idx ON game_economy_transactions(chat_id,created_at DESC)");
    await c.query("CREATE TABLE IF NOT EXISTS game_economy_vehicles (chat_id text NOT NULL,vehicle_key text NOT NULL,vehicle_name text,plate text,purchase_cost numeric NOT NULL DEFAULT 0,extra_cost numeric NOT NULL DEFAULT 0,realized_proceeds numeric NOT NULL DEFAULT 0,fees numeric NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'active',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(chat_id,vehicle_key))");
    await c.query("CREATE INDEX IF NOT EXISTS game_economy_vehicle_chat_idx ON game_economy_vehicles(chat_id,updated_at DESC)");
    return c;
  })().catch(e=>{console.log("GAME ECONOMY DB INIT ERROR:",e.message);dbPromise=null;return null;});
  return dbPromise;
}
function classify(before,after,button){
  const t=norm((before?.raw_message||before?.raw_text||"")+" "+(after?.raw_message||after?.raw_text||"")+" "+button);
  if(/продл|обновить объяв/.test(t))return "renewal";
  if(/снят(ь|ие).*номер|снять номер|удалить номер/.test(t))return "plate_removal";
  if(/комисси|аукцион|ставк.*номер|госномер/.test(t))return "plate";
  if(/продать|по рукам|принять предложение|покупател/.test(t))return "sale";
  if(/купить|покупка|продавец/.test(t))return "purchase";
  if(/ремонт|почин/.test(t))return "repair";
  if(/тюнинг|улучш/.test(t))return "tuning";
  if(/работ|контракт|заказ/.test(t))return "work";
  return "other";
}
function explicitFee(text){
  const t=norm(text);
  const m=t.match(/(?:комисси[яи]?|fee)[^0-9]{0,20}([0-9][0-9 .,_]*)/i);
  return m?num(m[1]):null;
}
async function recordTransition(chat,before,button,after){
  const c=await db();if(!c||chat==null)return;
  const b=num(before?.balance),a=num(after?.balance);
  const kind=classify(before,after,button);
  const info=vehicleInfo(after)||vehicleInfo(before);
  const beforeInfo=vehicleInfo(before);
  const screen=String(after?.raw_message||after?.raw_text||"").slice(0,12000);
  if(b==null||a==null||b===a)return;
  const delta=a-b;
  let fee=explicitFee(screen);
  if(fee==null && kind==="plate" && delta>0 && /(?:аукцион|ставк|продаж|комисси|номер|госномер)/i.test(screen)){
    fee=Math.round(delta*PLATE_AUCTION_COMMISSION/(1-PLATE_AUCTION_COMMISSION));
  }
  if(fee==null)fee=0;
  try{
    await c.query("INSERT INTO game_economy_transactions(chat_id,action,kind,amount,balance_before,balance_after,screen_text,vehicle_key,fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [String(chat),String(button||""),kind,delta,b,a,screen,info?.key||null,fee]);
    if(info){
      const row=await c.query("SELECT * FROM game_economy_vehicles WHERE chat_id=$1 AND vehicle_key=$2",[String(chat),info.key]);
      let purchaseCost=row.rows[0]?.purchase_cost?Number(row.rows[0].purchase_cost):0;
      let extra=row.rows[0]?.extra_cost?Number(row.rows[0].extra_cost):0;
      let proceeds=row.rows[0]?.realized_proceeds?Number(row.rows[0].realized_proceeds):0;
      let fees=row.rows[0]?.fees?Number(row.rows[0].fees):0;
      let status=row.rows[0]?.status||"active";
      if(kind==="purchase" && delta<0) purchaseCost+=-delta;
      if(kind==="sale" && delta>0){
        proceeds+=delta;
        fees+=fee;
        status="sold";
      } else if(kind==="plate" && delta>0) fees+=fee;
      if(delta<0 && kind!=="purchase" && kind!=="plate_removal" && kind!=="renewal" && kind!=="repair" && kind!=="tuning" && kind!=="other") extra+=-delta;
      if(kind==="renewal")extra+=Math.max(0,-delta);
      if(kind==="repair"||kind==="tuning")extra+=Math.max(0,-delta);
      if(kind==="plate_removal")extra+=Math.max(0,-delta);
      const knownCost=vehicleCostValue(after);
      if(knownCost!=null && knownCost>purchaseCost+extra)purchaseCost=Math.max(purchaseCost,knownCost-extra);
      await c.query("INSERT INTO game_economy_vehicles(chat_id,vehicle_key,vehicle_name,plate,purchase_cost,extra_cost,realized_proceeds,fees,status,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(chat_id,vehicle_key) DO UPDATE SET vehicle_name=excluded.vehicle_name,plate=excluded.plate,purchase_cost=excluded.purchase_cost,extra_cost=excluded.extra_cost,realized_proceeds=excluded.realized_proceeds,fees=excluded.fees,status=excluded.status,updated_at=now()",
        [String(chat),info.key,info.name,info.plate,purchaseCost,extra,proceeds,fees,status]);
    }
  }catch(e){console.log("GAME ECONOMY RECORD ERROR:",e.message);}
}
async function summary(chat,limit=100){
  const c=await db();if(!c||chat==null)return {transactions:[],net:0,spent:0,received:0,byKind:{},vehicles:[]};
  try{
    const r=await c.query("SELECT action,kind,amount,balance_before,balance_after,vehicle_key,fee,created_at FROM game_economy_transactions WHERE chat_id=$1 ORDER BY id DESC LIMIT $2",[String(chat),Math.max(1,Math.min(500,Number(limit)||100))]);
    const rows=r.rows.map(x=>({...x,amount:Number(x.amount),fee:Number(x.fee||0)}));
    const net=rows.reduce((s,x)=>s+x.amount,0),spent=rows.filter(x=>x.amount<0).reduce((s,x)=>s-x.amount,0),received=rows.filter(x=>x.amount>0).reduce((s,x)=>s+x.amount,0);
    const byKind={};for(const x of rows)byKind[x.kind]=(byKind[x.kind]||0)+x.amount;
    const vr=await c.query("SELECT vehicle_key,vehicle_name,plate,purchase_cost,extra_cost,realized_proceeds,fees,status,updated_at FROM game_economy_vehicles WHERE chat_id=$1 ORDER BY updated_at DESC LIMIT 50",[String(chat)]);
    const vehicles=vr.rows.map(x=>{const purchase=Number(x.purchase_cost||0),extra=Number(x.extra_cost||0),proceeds=Number(x.realized_proceeds||0),fees=Number(x.fees||0);return {...x,purchase_cost:purchase,extra_cost:extra,realized_proceeds:proceeds,fees,full_cost:purchase+extra,realized_profit:proceeds-purchase-extra-fees};});
    return {transactions:rows,net,spent,received,byKind,vehicles};
  }catch(e){return {transactions:[],net:0,spent:0,received:0,byKind:{},vehicles:[]};}
}
function expectedSale(offer,cost,commission=0){
  const o=num(offer),c=num(cost);if(o==null||c==null)return null;
  const fee=Math.max(0,o*Number(commission||0));
  return {offer:o,cost:c,fee,profit:o-c-fee};
}
function currentVehicleEconomics(state,offer,commission=0){
  const info=vehicleInfo(state);
  const base=vehicleCostValue(state);
  const o=num(offer);
  if(!info||base==null)return null;
  const sale=expectedSale(o,base,commission);
  return {vehicle:info,cost:base,offer:o,sale};
}
module.exports={recordTransition,summary,classify,expectedSale,RENEWAL_COST,PLATE_REMOVAL_COST,PLATE_AUCTION_COMMISSION,vehicleInfo};
