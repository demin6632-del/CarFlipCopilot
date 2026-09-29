const https = require("https");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const RELAY_TOKEN = process.env.COPILOT_TOKEN || "";
const GAME_USERNAME = process.env.GAME_BOT_USERNAME || "m0dsbeamngbot";
const CONNECT_URL = process.env.GAME_CONNECT_URL || "";
const API = "https://api.telegram.org/bot" + BOT_TOKEN;

let offset = 0;
const users = new Map();
let polling = false;

function tg(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(API + "/" + method);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {"content-type":"application/json","content-length":Buffer.byteLength(data)}
    }, res => {
      let s=""; res.on("data",c=>s+=c); res.on("end",()=>{
        try { const j=JSON.parse(s); if(!j.ok) return reject(new Error(j.description||"Telegram API error")); resolve(j.result); }
        catch(e){ reject(e); }
      });
    });
    req.on("error",reject); req.write(data); req.end();
  });
}

function kb() {
  const rows = [
    [{text:"🧠 Что делать сейчас",callback_data:"advice"}],
    [{text:"📊 Состояние",callback_data:"state"},{text:"📸 Анализ скрина",callback_data:"photo"}],
    [{text:"🔗 Подключить игру",callback_data:"connect"}]
  ];
  if (CONNECT_URL) rows.push([{text:"🎮 Открыть подключение",web_app:{url:CONNECT_URL}}]);
  return {inline_keyboard:rows};
}

async function send(chat_id, text, extra={}) {
  return tg("sendMessage", Object.assign({chat_id, text, reply_markup:kb()}, extra));
}

async function relay(path, body={}) {
  const base = process.env.RELAY_URL || "";
  if(!base) throw new Error("RELAY_URL не настроен");
  const u = new URL(base + path);
  const data = JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=https.request({
      hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:"POST",
      headers:{"content-type":"application/json","authorization":"Bearer "+RELAY_TOKEN,"content-length":Buffer.byteLength(data)}
    },res=>{let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{resolve(JSON.parse(s))}catch{resolve({raw:s})}})});
    req.on("error",reject);req.write(data);req.end();
  });
}

async function handle(m) {
  const chat=m.chat?.id;
  if(!chat) return;
  const text=String(m.text||"").trim();
  if(text==="/start"){
    users.set(chat,{connected:false});
    return send(chat,"🚗 CarFlipCopilot\n\nЯ буду твоим помощником по «Симулятору Перекупа».\n\nСначала подключим источник состояния игры, затем я смогу анализировать баланс, гараж, машины, сделки и говорить одно конкретное следующее действие.",{reply_markup:kb()});
  }
  if(text==="/connect") return connect(chat);
  if(text==="/state") return state(chat);
  if(text==="/advice") return advice(chat);
  if(text==="/help") return send(chat,"Команды:\n/connect — подключение игры\n/state — состояние\n/advice — что делать сейчас\n\nМожно также прислать скриншот игры.");
  if(m.photo?.length){
    const file=await tg("getFile",{file_id:m.photo[m.photo.length-1].file_id});
    const url="https://api.telegram.org/file/bot"+BOT_TOKEN+"/"+file.file_path;
    users.set(chat,Object.assign(users.get(chat)||{}, {lastPhoto:url}));
    return send(chat,"📸 Скриншот получен. Я могу разобрать его, но для полного автоматического анализа аккаунта нужно подключить источник состояния игры. Нажми «🔗 Подключить игру»."); 
  }
  if(text) return send(chat,"Нажми «🧠 Что делать сейчас» или пришли скриншот текущей ситуации.");
}

async function connect(chat){
  if(CONNECT_URL) return send(chat,"🔗 Подключение подготовлено. Открой игровое подключение и подтверди доступ.",{reply_markup:{inline_keyboard:[
    [{text:"🎮 Подключить игру",web_app:{url:CONNECT_URL}}],
    [{text:"↩️ Назад",callback_data:"menu"}]
  ]}});
  return send(chat,
    "🔗 Подключение игры\n\nИгра: @"+GAME_USERNAME+"\n\nСейчас у меня нет подтверждённого API/способа авторизации этой игры, поэтому я не буду просить у тебя пароль или код Telegram.\n\nЯ уже подготовил бота так, чтобы после появления официального API/ссылки авторизации подключение добавилось без переделки ИИ. Пока можно передавать состояние игры через CarFlipCopilot/скриншоты.");
}

async function state(chat){
  try {
    const r=await relay("/state");
    const s=r||{};
    return send(chat,"📊 Текущее состояние\n\n💰 Баланс: "+(s.balance??"неизвестно")+"\n🚗 Гараж: "+(s.garage??"неизвестно")+"\n🚘 Машина: "+(s.vehicle?.name||"нет данных")+"\n\nДанные показываются только если мост игры передал их в relay.");
  } catch(e) { return send(chat,"⚠️ Не удалось получить состояние: "+e.message); }
}

async function advice(chat){
  try {
    const r=await relay("/telegram/advice",{chat_id:chat});
    return send(chat,r.text||"Пока нет актуального состояния игры. Подключи источник состояния или пришли скриншот.");
  } catch(e) { return send(chat,"⚠️ Помощник пока не подключён к источнику состояния: "+e.message); }
}

async function callback(q){
  const chat=q.message?.chat?.id;
  const data=q.data;
  try { await tg("answerCallbackQuery",{callback_query_id:q.id}); } catch {}
  if(data==="connect") return connect(chat);
  if(data==="state") return state(chat);
  if(data==="advice") return advice(chat);
  if(data==="menu") return send(chat,"Главное меню:");
}

async function loop(){
  if(polling) return; polling=true;
  if(!BOT_TOKEN){console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN missing");return;}
  console.log("Telegram bot starting for @"+GAME_USERNAME);
  while(true){
    try{
      const updates=await tg("getUpdates",{offset,timeout:25,allowed_updates:["message","callback_query"]});
      for(const u of updates){
        offset=u.update_id+1;
        if(u.callback_query) await callback(u.callback_query);
        else if(u.message) await handle(u.message);
      }
    }catch(e){ console.log("Telegram polling error:",e.message); await new Promise(r=>setTimeout(r,3000)); }
  }
}
loop();
