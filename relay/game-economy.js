const { Client } = require("pg");
let dbPromise=null;
function num(v){if(v==null)return null;const n=Number(String(v).replace(/[^0-9.-]/g,""));return Number.isFinite(n)?n:null;}
function norm(v){return String(v||"").toLowerCase().replace(/ё/g,"е");}
async function db(){
 if(!process.env.DATABASE_URL)return null;
 if(!dbPromise)dbPromise=(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();await c.query("CREATE TABLE IF NOT EXISTS game_economy_transactions (id bigserial PRIMARY KEY,chat_id text NOT NULL,action text,kind text NOT NULL,amount numeric NOT NULL,balance_before numeric,balance_after numeric,screen_text text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");await c.query("CREATE INDEX IF NOT EXISTS game_economy_chat_idx ON game_economy_transactions(chat_id,created_at DESC)");return c;})().catch(e=>{console.log("GAME ECONOMY DB INIT ERROR:",e.message);dbPromise=null;return null;});
 return dbPromise;
}
function classify(before,after,button){
 const t=norm((before?.raw_message||"")+" "+(after?.raw_message||"")+" "+button);
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
async function recordTransition(chat,before,button,after){
 const c=await db();if(!c||chat==null)return;
 const b=num(before?.balance),a=num(after?.balance);if(b==null||a==null||b===a)return;
 const delta=a-b;
 try{await c.query("INSERT INTO game_economy_transactions(chat_id,action,kind,amount,balance_before,balance_after,screen_text) VALUES($1,$2,$3,$4,$5,$6,$7)",[String(chat),String(button||""),classify(before,after,button),delta,b,a,String(after?.raw_message||"").slice(0,12000)]);}
 catch(e){console.log("GAME ECONOMY RECORD ERROR:",e.message);}
}
async function summary(chat,limit=100){
 const c=await db();if(!c||chat==null)return {transactions:[],net:0,spent:0,received:0,byKind:{}};
 try{const r=await c.query("SELECT action,kind,amount,balance_before,balance_after,created_at FROM game_economy_transactions WHERE chat_id=$1 ORDER BY id DESC LIMIT $2",[String(chat),Math.max(1,Math.min(500,Number(limit)||100))]);const rows=r.rows.map(x=>({...x,amount:Number(x.amount)}));const net=rows.reduce((s,x)=>s+x.amount,0),spent=rows.filter(x=>x.amount<0).reduce((s,x)=>s-x.amount,0),received=rows.filter(x=>x.amount>0).reduce((s,x)=>s+x.amount,0);const byKind={};for(const x of rows)byKind[x.kind]=(byKind[x.kind]||0)+x.amount;return {transactions:rows,net,spent,received,byKind};}catch(e){return {transactions:[],net:0,spent:0,received:0,byKind:{}};}
}
module.exports={recordTransition,summary,classify};
