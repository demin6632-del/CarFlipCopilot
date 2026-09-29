const https = require("https");
const { TelegramUserBridge, createConnectServer } = require("./user-session-bridge");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const RELAY_TOKEN = process.env.COPILOT_TOKEN || "";
const RELAY_URL = process.env.RELAY_URL || "";
const GAME_USERNAME = process.env.GAME_BOT_USERNAME || "m0dsbeamngbot";
const CONNECT_URL = process.env.GAME_CONNECT_URL || "";
const BRIDGE_PUBLIC_URL = String(process.env.BRIDGE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/,"");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8787);
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const API = "https://api.telegram.org/bot" + BOT_TOKEN;

let offset = 0;
let polling = false;
const users = new Map();
const pendingGameProbes = new Map();
let lastBridgeNotice = 0;
let lastBridgeFingerprint = "";
async function notifyBridgeState(state) {
  const chat=userBridge.boundChatId;
  if(!chat || !state || !state.received_at) return;
  const fingerprint=JSON.stringify({balance:state.balance,garage:state.garage,vehicle:state.vehicle,raw_message:state.raw_message});
  if(fingerprint===lastBridgeFingerprint) return;
  lastBridgeFingerprint=fingerprint;
  const now=Date.now();
  if(now-lastBridgeNotice<5000) return;
  lastBridgeNotice=now;
  const lines=["🎮 Новое событие из игры","", "💰 Баланс: "+(state.balance??"—"), "🚗 Гараж: "+(state.garage??"—")];
  if(state.vehicle?.name) lines.push("🚘 "+state.vehicle.name);
  if(state.vehicle?.price!=null) lines.push("💵 Цена: "+state.vehicle.price);
  lines.push("", "Нажми «🧠 Что делать сейчас», чтобы получить решение ИИ.");
  try { await send(chat,lines.join("\n")); } catch(e) { console.log("BRIDGE NOTICE ERROR:",e.message); }
}

const userBridge = new TelegramUserBridge({
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  gameUsername: GAME_USERNAME,
  relayUrl: RELAY_URL,
  relayToken: RELAY_TOKEN,
  publicUrl: BRIDGE_PUBLIC_URL,
  sessionFile: process.env.TELEGRAM_SESSION_FILE || require("path").join(process.cwd(),"data","telegram-user-session.txt")
});
createConnectServer(userBridge,BRIDGE_PORT);

function tg(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(API + "/" + method);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {"content-type":"application/json","content-length":Buffer.byteLength(data)}
    }, res => {
      let s = "";
      res.on("data", c => s += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(s);
          if (!j.ok) return reject(new Error(j.description || "Telegram API error"));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function kb(chatId) {
  const rows = [
    [{text:"🧠 Что делать сейчас",callback_data:"advice"}],
    [{text:"📊 Состояние",callback_data:"state"},{text:"📸 Анализ скрина",callback_data:"photo"}],
    [{text:"🔗 Подключить игру",callback_data:"connect"}],
    [{text:"🧪 Проверить связь с игрой",callback_data:"probe"}]
  ];
  const connectUrl = CONNECT_URL || (BRIDGE_PUBLIC_URL && chatId ? BRIDGE_PUBLIC_URL + "/connect?ticket=" + encodeURIComponent(userBridge.createTicket(chatId)) : "");
  if (connectUrl) rows.push([{text:"🎮 Открыть подключение",web_app:{url:connectUrl}}]);
  return {inline_keyboard:rows};
}

async function send(chat_id, text, extra={}) {
  return tg("sendMessage", Object.assign({
    chat_id, text, reply_markup:kb(chat_id), disable_web_page_preview:true
  }, extra));
}

async function relay(path, body={}) {
  if (!RELAY_URL) throw new Error("RELAY_URL не настроен");
  const u = new URL(RELAY_URL + path);
  const data = JSON.stringify(body);
  return new Promise((resolve,reject) => {
    const req = https.request({
      hostname:u.hostname, port:u.port || 443,
      path:u.pathname+u.search, method:"POST",
      headers:{
        "content-type":"application/json",
        "authorization":"Bearer "+RELAY_TOKEN,
        "content-length":Buffer.byteLength(data)
      }
    }, res => {
      let s=""; res.on("data",c=>s+=c);
      res.on("end",()=>{try{resolve(JSON.parse(s))}catch{resolve({raw:s})}});
    });
    req.on("error",reject); req.write(data); req.end();
  });
}

async function downloadTelegramFile(fileId) {
  const file = await tg("getFile",{file_id:fileId});
  if (!file || !file.file_path) throw new Error("Telegram не вернул путь к файлу");
  const u = new URL("https://api.telegram.org/file/bot"+BOT_TOKEN+"/"+file.file_path);
  return new Promise((resolve,reject) => {
    https.get(u,res => {
      const chunks=[];
      res.on("data",c=>chunks.push(c));
      res.on("end",()=>resolve(Buffer.concat(chunks)));
      res.on("error",reject);
    }).on("error",reject);
  });
}

async function analyzePhotoWithAI(bytes) {
  if(!OPENAI_KEY) throw new Error("OPENAI_API_KEY не настроен");
  const prompt =
    "Ты — CarFlipCopilot для игры «Симулятор Перекупа». Разбери скриншот. "+
    "Извлеки только реально видимые данные: баланс, гараж, автомобиль, цену, пробег, мощность, владельцев, окрашенные детали, предложения покупателей, расходы и события. "+
    "Учитывай, что в игре НЕТ аукционов автомобилей; есть аукцион номеров. "+
    "В конце дай одно конкретное действие, которое игроку нужно сделать прямо сейчас. "+
    "Если данных недостаточно, скажи, чего не хватает. Не выдумывай числа. "+
    "Ответ на русском, коротко и по делу.";
  const body={
    model:OPENAI_MODEL,
    input:[{role:"user",content:[
      {type:"input_text",text:prompt},
      {type:"input_image",image_url:"data:image/jpeg;base64,"+bytes.toString("base64")}
    ]}]
  };
  const data=JSON.stringify(body);
  const u=new URL("https://api.openai.com/v1/responses");
  return new Promise((resolve,reject)=>{
    const req=https.request({
      hostname:u.hostname,path:u.pathname,method:"POST",
      headers:{
        "content-type":"application/json",
        "authorization":"Bearer "+OPENAI_KEY,
        "content-length":Buffer.byteLength(data)
      }
    },res=>{
      let s="";res.on("data",x=>s+=x);
      res.on("end",()=>{
        try{
          const j=JSON.parse(s);
          if(!res.statusCode||res.statusCode>=300) return reject(new Error(j.error?.message||"OpenAI error"));
          const out=String(j.output_text||j.output?.flatMap(x=>x.content||[]).filter(x=>x.text).map(x=>x.text).join("")||"");
          if(!out) return reject(new Error("ИИ не вернул результат"));
          resolve(out);
        }catch(e){reject(e)}
      });
    });
    req.on("error",reject);req.write(data);req.end();
  });
}

async function handlePhoto(chat, photo) {
  try {
    const best = photo[photo.length-1];
    const bytes = await downloadTelegramFile(best.file_id);
    const result = await analyzePhotoWithAI(bytes);
    return send(chat, "📸 Анализ скриншота\n\n"+result);
  } catch(e) {
    return send(chat, "⚠️ Не удалось разобрать скриншот: "+e.message);
  }
}

async function handle(m) {
  const chat=m.chat?.id;
  if(!chat) return;
  const text=String(m.text||"").trim();

  if(text==="/start") {
    users.set(chat,{connected:false});
    return send(chat,
      "🚗 CarFlipCopilot\n\n"+
      "Я работаю прямо внутри Telegram. Android-приложение для общения со мной не нужно.\n\n"+
      "Моя задача — смотреть состояние «Симулятора Перекупа», учитывать историю сделок и говорить одно конкретное следующее действие.\n\n"+
      "Начни с «🔗 Подключить игру».");
  }
  if(text==="/connect") return connect(chat);
  if(text==="/state") return state(chat);
  if(text==="/advice") return advice(chat);
  if(text==="/probe") return probe(chat);
  if(text==="/bridge") return bridgeStatus(chat);
  if(text==="/help") return send(chat,
    "Команды:\n/connect — подключение игры\n/state — состояние\n/advice — что делать сейчас\n/probe — проверить связь с игровым ботом\n\n"+
    "Можно прислать скриншот текущей ситуации — бот разберёт его прямо здесь.");

  if(m.photo?.length) return handlePhoto(chat,m.photo);
  if(text) return send(chat,"Используй кнопки ниже или пришли скриншот игры.");
}

async function connect(chat) {
  if(CONNECT_URL || BRIDGE_PUBLIC_URL) {
    const url = CONNECT_URL || (BRIDGE_PUBLIC_URL + "/connect?ticket=" + encodeURIComponent(userBridge.createTicket(chat)));
    return send(chat,
      "🔗 Открываю защищённое подключение.\n\nПосле авторизации мост привяжет твой Telegram-профиль к состоянию игры.",
      {reply_markup:{inline_keyboard:[
        [{text:"🎮 Подключить игру",web_app:{url}}],
        [{text:"🧪 Проверить связь",callback_data:"probe"}],
        [{text:"↩️ Назад",callback_data:"menu"}]
      ]}});
  }

  return send(chat,
    "🔗 Подключение игры\n\n"+
    "Игра: @"+GAME_USERNAME+"\n\n"+
    "Пользовательский Telegram-мост: "+(userBridge.configured()?"готов":"не настроен")+"\n\n"+
    "Бот уже готов к игровому мосту, но URL авторизации пока не настроен. "+
    "Я не буду просить пароль или код Telegram в сообщении.\n\n"+
    "Пока можно нажать «🧪 Проверить связь» или присылать скриншоты — они анализируются прямо через Telegram.");
}

async function bridgeStatus(chat) {
  const s=userBridge.status();
  return send(chat,
    "🔗 Telegram-мост\n\n"+
    "Статус: "+(s.connected?"✅ подключён":"❌ не подключён")+"\n"+
    "Игровой бот: @"+GAME_USERNAME+"\n"+
    "Пользователь: "+(s.username?"@"+s.username:"не определён")+"\n"+
    (s.last_error?"\n⚠️ "+s.last_error:""));
}

async function state(chat) {
  try {
    const r=await relay("/state");
    const s=r||{};
    return send(chat,
      "📊 Текущее состояние\n\n"+
      "💰 Баланс: "+(s.balance??"неизвестно")+"\n"+
      "🚗 Гараж: "+(s.garage??"неизвестно")+"\n"+
      "🚘 Машина: "+(s.vehicle?.name||"нет данных")+"\n\n"+
      "Это данные, которые игровой мост передал relay.");
  } catch(e) {
    return send(chat,"⚠️ Состояние пока недоступно: "+e.message);
  }
}

async function advice(chat) {
  try {
    const r=await relay("/telegram/advice",{chat_id:chat});
    return send(chat,r.text||"Пока нет актуального решения. Передай состояние игры или скриншот.");
  } catch(e) {
    return send(chat,"⚠️ Помощник пока не получил состояние игры: "+e.message);
  }
}

async function probe(chat) {
  try {
    const result = await tg("sendMessage",{chat_id:"@"+GAME_USERNAME,text:"/start"});
    pendingGameProbes.set(chat,Date.now());
    return send(chat,
      "🧪 Запрос отправлен в @"+GAME_USERNAME+".\n\n"+
      "Это только тест Telegram-связи между ботами. Он не означает, что CarFlipCopilot получил доступ к твоему игровому аккаунту. "+
      "Для этого нужен отдельный пользовательский игровой мост.");
  } catch(e) {
    return send(chat,
      "⚠️ Telegram не разрешил отправить тест в @"+GAME_USERNAME+".\n\n"+
      "Это нормально, если у игрового бота не включён Bot-to-Bot Communication Mode.");
  }
}

async function callback(q) {
  const chat=q.message?.chat?.id;
  const data=q.data;
  try { await tg("answerCallbackQuery",{callback_query_id:q.id}); } catch {}
  if(data==="connect") return connect(chat);
  if(data==="state") return state(chat);
  if(data==="advice") return advice(chat);
  if(data==="probe") return probe(chat);
  if(data==="photo") return send(chat,"📸 Просто отправь сюда скриншот игры.");
  if(data==="menu") return send(chat,"Главное меню:");
}

async function loop() {
  if(polling) return;
  polling=true;
  if(!BOT_TOKEN) {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN missing");
    return;
  }
  console.log("Telegram bot starting for @"+GAME_USERNAME);
  while(true) {
    try {
      const updates=await tg("getUpdates",{
        offset,timeout:25,allowed_updates:["message","callback_query"]
      });
      for(const u of updates) {
        offset=u.update_id+1;
        if(u.callback_query) await callback(u.callback_query);
        else if(u.message) await handle(u.message);
      }
    } catch(e) {
      console.log("Telegram polling error:",e.message);
      await new Promise(r=>setTimeout(r,3000));
    }
  }
}
if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
  userBridge.ensureClient().then(()=>console.log("Telegram user bridge initialized")).catch(e=>console.log("Telegram user bridge init:",e.message));
}
loop();
