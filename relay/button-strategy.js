
const crypto = require("crypto");
const { Client } = require("pg");
let dbPromise = null;

function norm(v){ return String(v||"").toLowerCase().replace(/ё/g,"е").replace(/[^a-zа-я0-9]+/gi," ").trim(); }
function screenKey(text){ return crypto.createHash("sha256").update(norm(String(text||"")).slice(0,12000)).digest("hex"); }
function contextKey(text){
  const t=norm(text), p=[];
  if(/предлож|покупател|готов купить|торг/.test(t)) p.push("buyer");
  if(/купить|покупка|продавец/.test(t)) p.push("purchase");
  if(/продать|продажа|по рукам|объявлен/.test(t)) p.push("sale");
  if(/аукцион|торги|ставка|госномер|номер/.test(t)) p.push("auction");
  if(/гараж|машин|авто/.test(t)) p.push("garage");
  if(/ремонт|почин/.test(t)) p.push("repair");
  if(/тюнинг|улучш/.test(t)) p.push("tune");
  if(/контракт|заказ|работ/.test(t)) p.push("work");
  return p.join("+")||"other";
}
function buttonType(label){
  const n=norm(label);
  if(/куп|покуп|приобр|взять|забрать|торг/.test(n)) return "buy";
  if(/прод|продаж|сбыть|по рукам|принять предложение/.test(n)) return "sell";
  if(/осмотр|провер|диагност|оцен|состояни/.test(n)) return "inspect";
  if(/продл|обновить|поднять объяв/.test(n)) return "renew";
  if(/отмен|назад|выйти|вернуться/.test(n)) return "cancel";
  if(/гараж|машин|авто/.test(n)) return "garage";
  if(/номер|госномер|аукцион/.test(n)) return "plate";
  if(/ремонт|почин/.test(n)) return "repair";
  if(/тюнинг|улучш/.test(n)) return "tune";
  if(/работ|контракт|заказ/.test(n)) return "work";
  if(/подтверд|оформ|готово|да/.test(n)) return "confirm";
  if(/далее|продолж|след|исслед|ехать|вперед|вперёд/.test(n)) return "continue";
  return "other";
}
async function db(){
  if(!process.env.DATABASE_URL) return null;
  if(!dbPromise){
    dbPromise=(async()=>{
      const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
      await c.connect();
      await c.query("CREATE TABLE IF NOT EXISTS button_strategy_history (id bigserial PRIMARY KEY,chat_id text NOT NULL,screen_key text NOT NULL,context_key text NOT NULL,screen_text text NOT NULL,buttons jsonb NOT NULL,clicked_button text,next_screen_key text,created_at timestamptz NOT NULL DEFAULT now())");
      await c.query("CREATE INDEX IF NOT EXISTS button_strategy_history_chat_idx ON button_strategy_history(chat_id,created_at DESC)");
      return c;
    })().catch(e=>{console.log("BUTTON STRATEGY DB INIT ERROR:",e.message);dbPromise=null;return null;});
  }
  return dbPromise;
}
async function recordScreen(chat,text,buttons){
  const c=await db(); if(!c||chat==null)return;
  try{await c.query("INSERT INTO button_strategy_history(chat_id,screen_key,context_key,screen_text,buttons) VALUES($1,$2,$3,$4,$5)",[String(chat),screenKey(text),contextKey(text),String(text||"").slice(0,12000),JSON.stringify((buttons||[]).map(String))]);}
  catch(e){console.log("BUTTON STRATEGY RECORD ERROR:",e.message);}
}
async function recordClick(chat,text,buttons,label,nextText){
  const c=await db(); if(!c||chat==null)return;
  try{await c.query("UPDATE button_strategy_history SET clicked_button=$1,next_screen_key=$2 WHERE id=(SELECT id FROM button_strategy_history WHERE chat_id=$3 AND screen_key=$4 ORDER BY id DESC LIMIT 1)",[String(label||""),screenKey(nextText||""),String(chat),screenKey(text||"")]);}
  catch(e){console.log("BUTTON STRATEGY CLICK RECORD ERROR:",e.message);}
}
function scoreButtons(buttons,state,history){
  const list=[...new Set((buttons||[]).map(x=>String(x||"").trim()).filter(Boolean))];
  if(!list.length)return [];
  const raw=String(state?.raw_message||state?.raw_text||""), t=norm(raw), ctx=contextKey(raw);
  const balance=Number(state?.balance),price=Number(state?.price);
  const hasBalance=Number.isFinite(balance)&&balance>0, hasPrice=Number.isFinite(price)&&price>0;
  const counts={};
  for(const h of history||[]){const label=String(h.clicked_button||"");if(label)counts[norm(label)]=(counts[norm(label)]||0)+(h.context_key===ctx?2:1);}
  const scores=list.map(label=>{
    const type=buttonType(label),n=norm(label); let score=10;
    if(type==="cancel")score-=7;
    if(type==="inspect")score+=/авто|машин|состояни/.test(t)?8:2;
    if(type==="buy")score+=/купить|покупка|продавец|лот|автомобил|машин/.test(t)?7:-3;
    if(type==="sell")score+=/продать|продажа|покупател|предложение|по рукам|объявлен/.test(t)?9:-2;
    if(type==="renew")score+=/объявлен|продаж|продлить|покупател/.test(t)?8:-1;
    if(type==="plate")score+=/номер|госномер|аукцион|ставка|лот/.test(t)?10:-2;
    if(type==="repair")score+=/состояни|износ|повреж|ремонт/.test(t)?7:-1;
    if(type==="tune")score+=/л с|мощн|тюнинг|улучш/.test(t)?6:-1;
    if(type==="work")score+=/контракт|заказ|работ/.test(t)?8:-1;
    if(type==="garage")score+=/гараж|мест|слот/.test(t)?6:-2;
    if(type==="confirm")score+=/подтверд|оформ|готов|соглас/.test(t)?6:-2;
    if(type==="continue")score+=/далее|продолж|след|ехать|вперед|вперёд/.test(t)?7:0;
    if(type==="buy"&&hasBalance&&hasPrice){if(price>balance)score-=25;else if(price<=balance*.55)score+=7;else if(price<=balance*.8)score+=3;else score-=3;}
    if(type==="sell"&&hasPrice&&/влож|себесто|купил|затрат/.test(t))score+=6;
    score+=Math.min(18,Math.log1p(counts[n]||0)*4);
    const escaped=n.replace(/[.*+?^$()|[\]\\]/g,"\\$&");
    const direct=new RegExp("(?:нажми|выбери|нужно нажать|следует нажать|рекомендуется нажать)\\s+[«\\\"“]?"+escaped+"[»\\\"”]?","i");
    if(direct.test(raw))score+=40;
    return {label,type,rawScore:Math.max(.1,score)};
  });
  const min=Math.min(...scores.map(x=>x.rawScore));
  const shifted=scores.map(x=>({...x,weight:x.rawScore-min+2}));
  const total=shifted.reduce((a,x)=>a+x.weight,0);
  return shifted.map(x=>({...x,percent:Math.round(x.weight/total*100)})).sort((a,b)=>b.percent-a.percent);
}
async function rankButtons(chat,state,buttons){
  const c=await db(); let history=[];
  if(c&&chat!=null)try{const r=await c.query("SELECT context_key,clicked_button FROM button_strategy_history WHERE chat_id=$1 AND clicked_button IS NOT NULL ORDER BY id DESC LIMIT 500",[String(chat)]);history=r.rows;}catch(e){console.log("BUTTON STRATEGY HISTORY ERROR:",e.message);}
  const ranked=scoreButtons(buttons,state,history);
  if(ranked.length){
    const diff=100-ranked.reduce((a,x)=>a+x.percent,0); ranked[0].percent+=diff;
    for(const x of ranked)x.reason=reasonFor(x,state,history);
  }
  return ranked;
}
function reasonFor(x,state,history){
  const t=norm(state?.raw_message||state?.raw_text),r=[];
  if(x.type==="buy"&&/купить|покупка|продавец/.test(t))r.push("экран содержит контекст покупки");
  if(x.type==="sell"&&/продать|продажа|покупател|предложение/.test(t))r.push("экран содержит контекст продажи");
  if(x.type==="plate"&&/номер|аукцион|ставка/.test(t))r.push("обнаружен контекст госномера/аукциона");
  if(x.type==="inspect")r.push("проверка снижает риск перед финансовым действием");
  const learned=(history||[]).filter(h=>norm(h.clicked_button)===norm(x.label)).length;
  if(learned)r.push("учтена история этой кнопки в твоих игровых экранах");
  return r.join("; ")||"оценка по текущему экрану и общей модели игровой стратегии";
}
module.exports={rankButtons,recordScreen,recordClick};
