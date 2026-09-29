const https = require("https");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const RELAY_TOKEN = process.env.COPILOT_TOKEN || "";
const RELAY_URL = process.env.RELAY_URL || "";
const GAME_USERNAME = process.env.GAME_BOT_USERNAME || "m0dsbeamngbot";
const CONNECT_URL = process.env.GAME_CONNECT_URL || "";
const API = "https://api.telegram.org/bot" + BOT_TOKEN;

let offset = 0;
let polling = false;
const users = new Map();
const pendingGameProbes = new Map();

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

function kb() {
  const rows = [
    [{text:"🧠 Что делать сейчас",callback_data:"advice"}],
    [{text:"📊 Состояние",callback_data:"state"},{text:"📸 Анализ скрина",callback_data:"photo"}],
    [{text:"🔗 Подключить игру",callback_data:"connect"}],
    [{text:"🧪 Проверить связь с игрой",callback_data:"probe"}]
  ];
  if (CONNECT_URL) rows.push([{text:"🎮 Открыть подключение",web_app:{url:CONNECT_URL}}]);
  return {inline_keyboard:rows};
}

async function send(chat_id, text, extra={}) {
  return tg("sendMessage", Object.assign({
    chat_id, text, reply_markup:kb(), disable_web_page_preview:true
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

async function handlePhoto(chat, photo) {
  try {
    const best = photo[photo.length-1];
    const bytes = await downloadTelegramFile(best.file_id);
    const r = await relay("/telegram/analyze-photo", {
      chat_id:chat, image_base64:bytes.toString("base64"), mime:"image/jpeg"
    });
    return send(chat, r.text || "📸 Скриншот принят.");
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
  if(text==="/help") return send(chat,
    "Команды:\n/connect — подключение игры\n/state — состояние\n/advice — что делать сейчас\n/probe — проверить связь с игровым ботом\n\n"+
    "Можно прислать скриншот текущей ситуации — бот разберёт его прямо здесь.");

  if(m.photo?.length) return handlePhoto(chat,m.photo);
  if(text) return send(chat,"Используй кнопки ниже или пришли скриншот игры.");
}

async function connect(chat) {
  if(CONNECT_URL) {
    return send(chat,
      "🔗 Открываю защищённое подключение.\n\nПосле авторизации мост привяжет твой Telegram-профиль к состоянию игры.",
      {reply_markup:{inline_keyboard:[
        [{text:"🎮 Подключить игру",web_app:{url:CONNECT_URL}}],
        [{text:"🧪 Проверить связь",callback_data:"probe"}],
        [{text:"↩️ Назад",callback_data:"menu"}]
      ]}});
  }

  return send(chat,
    "🔗 Подключение игры\n\n"+
    "Игра: @"+GAME_USERNAME+"\n\n"+
    "Бот уже готов к игровому мосту, но URL авторизации пока не настроен. "+
    "Я не буду просить пароль или код Telegram в сообщении.\n\n"+
    "Пока можно нажать «🧪 Проверить связь» или присылать скриншоты — они анализируются прямо через Telegram.");
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
loop();
