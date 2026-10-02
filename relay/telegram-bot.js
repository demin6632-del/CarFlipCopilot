const https = require("https");
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:32,maxFreeSockets:8,timeout:60000,freeSocketTimeout:15000});
const { TelegramUserBridge, createConnectServer } = require("./user-session-bridge");
const { analyzeImage, parseState, decide, warmup } = require("./free-analyzer");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const RELAY_TOKEN = process.env.COPILOT_TOKEN || "";
const RELAY_URL = process.env.RELAY_URL || "";
const GAME_USERNAME = process.env.GAME_BOT_USERNAME || "m0dsbeamngbot";
const CONNECT_URL = process.env.GAME_CONNECT_URL || "";
const BRIDGE_PUBLIC_URL = String(process.env.BRIDGE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/,"");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8787);
const API = "https://api.telegram.org/bot" + BOT_TOKEN;

let offset=0,polling=false,webhookEnabled=false;
process.on("unhandledRejection",e=>console.log("UNHANDLED REJECTION:",e?.stack||e?.message||e));
process.on("uncaughtException",e=>console.log("UNCAUGHT EXCEPTION:",e?.stack||e?.message||e));
const users=new Map(),pendingGameProbes=new Map();
const photoFingerprints=new Map();
const photoFileIds=new Map();
const processingChats=new Set();
let lastBridgeNotice=0,lastBridgeFingerprint="";

function normalizeButtonText(s){return String(s||"").toLowerCase().replace(/ё/g,"е").replace(/[^a-zа-я0-9]+/gi," ").trim();}
function classifyGameButton(label){
  const n=normalizeButtonText(label);
  const tests=[
    ["buy",/(куп|покуп|приобр|взять|забрать|торг)/i],
    ["sell",/(прод|продаж|сбыть|по\s*рукам|принять\s+предлож)/i],
    ["inspect",/(осмотр|провер|диагност|оцен|состояни)/i],
    ["renew",/(продл|обновить|поднять\s+объяв)/i],
    ["cancel",/(отмен|назад|выйти|вернуться)/i],
    ["garage",/(гараж|машин|авто)/i],
    ["plate",/(номер|госномер|аукцион)/i],
    ["repair",/(ремонт|почин)/i],
    ["tune",/(тюнинг|улучш)/i],
    ["work",/(работ|контракт|заказ)/i],
    ["confirm",/(подтверд|оформ|готово|да)/i],
    ["continue",/(далее|продолж|след|исслед|ехать|вперед|впер[её]д)/i]
  ];
  for(const [type,re] of tests)if(re.test(n))return type;
  return "other";
}
function buttonChoiceAnalysis(decision,state,buttons){
  const list=[...new Set((Array.isArray(buttons)?buttons:[]).map(x=>String(x||"").trim()).filter(Boolean))];
  if(!list.length)return [];
  const source=normalizeButtonText([decision?.action,decision?.title,decision?.reason,state?.raw_message,state?.raw_text].filter(Boolean).join(" "));
  const action=normalizeButtonText(decision?.action||"");
  const type=action.includes("куп")?"buy":action.includes("прод")?"sell":action.includes("осмотр")||action.includes("провер")?"inspect":action.includes("номер")||action.includes("аукцион")?"plate":action.includes("ремонт")?"repair":action.includes("тюнинг")?"tune":action.includes("работ")?"work":action.includes("гараж")?"garage":action.includes("отмен")?"cancel":action.includes("продолж")||action.includes("далее")?"continue":null;
  const financial=!!(state&&(state.price!=null||state.balance!=null||state.vehicle?.name));
  const raw=String(state?.raw_message||state?.raw_text||"").toLowerCase();
  const weights=list.map(label=>{
    const bt=classifyGameButton(label), n=normalizeButtonText(label);
    let score=30;
    if(type&&bt===type)score+=65;
    if(type&&bt==="confirm"&&["buy","sell","plate","repair","tune"].includes(type))score+=18;
    if(type&&bt==="cancel")score-=28;
    if(bt==="inspect"&&(!financial||/провер|осмотр|оцен/i.test(source)))score+=18;
    if(bt==="sell"&&/предлож|покупател|по\s*рукам|торг/i.test(raw))score+=28;
    if(bt==="renew"&&/объяв|продл|ставк|предлож/i.test(raw))score+=16;
    if(bt==="buy"&&/куп|покуп/i.test(raw))score+=18;
    if(bt==="continue"&&/след|далее|продолж|исслед/i.test(source))score+=16;
    if(bt==="cancel"&&/отмен|назад|выйти/i.test(source))score+=12;
    if(bt==="work"&&/работ|контракт|заказ/i.test(source))score+=16;
    if(bt==="garage"&&/гараж|машин|авто/i.test(source))score+=12;
    for(const w of source.split(/\s+/).filter(x=>x.length>=4))if(n.includes(w))score+=1;
    if(!financial&&["buy","sell","repair","tune"].includes(bt))score-=12;
    return {label,type:bt,score:Math.max(1,score)};
  });
  const max=Math.max(...weights.map(x=>x.score));
  const exp=weights.map(x=>({...x,weight:Math.exp((x.score-max)/14)}));
  const total=exp.reduce((s,x)=>s+x.weight,0)||1;
  const rawPerc=exp.map(x=>x.weight/total*100);
  const base=rawPerc.map(x=>Math.floor(x));
  let remaining=100-base.reduce((s,x)=>s+x,0);
  const order=rawPerc.map((v,i)=>({i,f:v-Math.floor(v)})).sort((a,b)=>b.f-a.f);
  for(let i=0;i<remaining;i++)base[order[i%order.length].i]+=1;
  return weights.map((x,i)=>({...x,percent:base[i]})).sort((a,b)=>b.percent-a.percent);
}
function buttonScoreText(ranked){
  if(!ranked.length)return "";
  return ranked.map((x,i)=>(i===0?"⭐ ":"")+String(i+1)+". «"+x.label+"» — "+x.percent+"%").join("\n");
}
function recommendGameButton(decision,buttons,state){
  const ranked=buttonChoiceAnalysis(decision,state,buttons);
  return ranked[0]?.label||null;
}
function actionRisk(action){return /(куп|покуп|прод|продаж|аукцион|номер|ремонт|тюнинг|оплат|подтверд|оформ)/i.test(normalizeButtonText(action));}
function gameButtonKey(label){
  return require("crypto").createHash("sha256").update(String(label||"")).digest("hex").slice(0,16);
}
function currentGameButton(key){
  const buttons=userBridge.status()?.last_game_message?.buttons;
  if(!Array.isArray(buttons))return null;
  return buttons.find(label=>gameButtonKey(label)===key)||null;
}
function gameButtonData(label,messageId){return "gamebtn:"+String(messageId||"0")+":"+gameButtonKey(label);}
function confirmButtonData(label,messageId){return "confirmbtn:"+String(messageId||"0")+":"+gameButtonKey(label);}
function gameButtonRef(data,prefix){const p=String(data||"").split(":");if(p.length===3&&p[0]===prefix)return{messageId:p[1],key:p[2],legacy:false};if(p.length===2&&p[0]===prefix)return{messageId:null,key:p[1],legacy:true};return null;}

async function notifyBridgeState(state){
  const chat=userBridge.boundChatId;if(!chat||!state||!state.received_at)return;
  const fingerprint=JSON.stringify({balance:state.balance,garage:state.garage,vehicle:state.vehicle,raw_message:state.raw_message});
  if(fingerprint===lastBridgeFingerprint)return;lastBridgeFingerprint=fingerprint;
  if(Date.now()-lastBridgeNotice<5000)return;lastBridgeNotice=Date.now();
  const lines=["🎮 Новое событие из игры","","💰 Баланс: "+(state.balance??"—"),"🚗 Гараж: "+(state.garage??"—")];
  if(state.vehicle?.name)lines.push("🚘 "+state.vehicle.name);
  if(state.vehicle?.price!=null)lines.push("💵 Цена: "+state.vehicle.price);
  const autoDecision=state.local_decision||decide(state,90);\n  const ranked=buttonChoiceAnalysis(autoDecision,state,state.buttons||[]);\n  if(ranked.length){\n    lines.push("","🧠 АВТОАНАЛИЗ КНОПОК","➡️ Лучше нажать: «"+ranked[0].label+"» — "+ranked[0].percent+"%");\n    lines.push("📊 ВСЕ КНОПКИ:\\n"+buttonScoreText(ranked));\n  }else lines.push("","Нажми «🧠 Что делать сейчас», чтобы получить решение ИИ.");
  try{await send(chat,lines.join("\n"));}catch(e){console.log("BRIDGE NOTICE ERROR:",e.message);}
}

const userBridge=new TelegramUserBridge({
  apiId:process.env.TELEGRAM_API_ID,apiHash:process.env.TELEGRAM_API_HASH,gameUsername:GAME_USERNAME,
  relayUrl:RELAY_URL,relayToken:RELAY_TOKEN,publicUrl:BRIDGE_PUBLIC_URL,
  onState:notifyBridgeState,
  sessionFile:process.env.TELEGRAM_SESSION_FILE||require("path").join(process.cwd(),"data","telegram-user-session.txt")
});
createConnectServer(userBridge,BRIDGE_PORT);

async function registerBotCommands(){
  const commands=[
    {command:"start",description:"Открыть главное меню"},
    {command:"connect",description:"Подключить игру"},
    {command:"state",description:"Показать состояние игры"},
    {command:"advice",description:"Что делать сейчас"},
    {command:"probe",description:"Проверить связь с игрой"},
    {command:"help",description:"Помощь и список команд"}
  ];
  try{ await tg("setMyCommands",{commands,scope:{type:"all_private_chats"}}); console.log("Telegram commands registered"); }
  catch(e){ console.log("COMMANDS REGISTER ERROR:",e.message); }
}
function tg(method,body){return new Promise((resolve,reject)=>{
  const data=JSON.stringify(body||{}),u=new URL(API+"/"+method);
  const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},res=>{
    let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{const j=JSON.parse(s);if(!j.ok)return reject(new Error(j.description||"Telegram API error"));resolve(j.result);}catch(e){reject(e);}});
  });req.on("error",reject);req.setTimeout(35000,()=>{req.destroy(new Error("Telegram API timeout"));});req.write(data);req.end();
});}
function kb(chatId){
  const rows=[[{text:"🧠 Что делать сейчас",callback_data:"advice"}],[{text:"📊 Состояние",callback_data:"state"},{text:"📸 Анализ скрина",callback_data:"photo"}],[{text:"🔗 Подключить игру",callback_data:"connect"}],[{text:"🧪 Проверить связь с игрой",callback_data:"probe"}]];
  const connectBase=CONNECT_URL||(BRIDGE_PUBLIC_URL?BRIDGE_PUBLIC_URL+"/connect":"");
  const connectUrl=connectBase&&chatId ? connectBase+(connectBase.includes("?")?"&":"?")+"ticket="+encodeURIComponent(userBridge.createTicket(chatId)) : "";
  if(connectUrl)rows.push([{text:"🎮 Открыть подключение",web_app:{url:connectUrl}}]);
  return {inline_keyboard:rows};
}
async function send(chat_id,text,extra={}){return tg("sendMessage",Object.assign({chat_id,text,reply_markup:kb(chat_id),disable_web_page_preview:true},extra));}
async function relay(path,body={}){if(!RELAY_URL)throw new Error("RELAY_URL не настроен");const u=new URL(RELAY_URL+path),data=JSON.stringify(body);
  return new Promise((resolve,reject)=>{const req=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","authorization":"Bearer "+RELAY_TOKEN,"content-length":Buffer.byteLength(data)}},res=>{let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{resolve(JSON.parse(s))}catch{resolve({raw:s})}})});req.on("error",reject);req.setTimeout(20000,()=>{req.destroy(new Error("Relay timeout"));});req.write(data);req.end();});
}
async function downloadTelegramFile(fileId){const file=await tg("getFile",{file_id:fileId});if(!file?.file_path)throw new Error("Telegram не вернул путь к файлу");const u=new URL("https://api.telegram.org/file/bot"+BOT_TOKEN+"/"+file.file_path);
  return new Promise((resolve,reject)=>{const req=https.get(u,{agent:keepAliveAgent},res=>{
    if(res.statusCode!==200){res.resume();return reject(new Error("Telegram file download HTTP "+res.statusCode));}
    const chunks=[];let size=0;
    res.on("data",c=>{size+=c.length;if(size>50*1024*1024){req.destroy(new Error("Файл слишком большой"));return;}chunks.push(c);});
    res.on("end",()=>resolve(Buffer.concat(chunks)));
    res.on("error",reject);
  });
  req.setTimeout(30000,()=>req.destroy(new Error("Telegram file download timeout")));
  req.on("error",reject);});
}

async function analyzePhotoFree(bytes, precomputed=null){
  const r=precomputed || await analyzeImage(bytes),v=r.vehicle||{},d=r.decision||{};
  const lines=[
    "📸 БЕСПЛАТНЫЙ АНАЛИЗ СКРИНШОТА","",
    "💰 Баланс: "+(r.balance!=null?r.balance.toLocaleString("ru-RU")+" ₽":"не распознан"),
    "🚗 Гараж: "+(r.garage??"не распознан"),
    v.name?"🚘 Авто: "+v.name:"",
    v.price!=null?"💵 Цена: "+v.price.toLocaleString("ru-RU")+" ₽":"",
    v.mileage!=null?"🛣 Пробег: "+v.mileage.toLocaleString("ru-RU")+" км":"",
    v.hp!=null?"⚙️ Мощность: "+v.hp+" л.с.":"",
    v.owners!=null?"👤 Владельцев: "+v.owners:"",
    r.plate?"🔢 Номер: "+r.plate:"",
    "",
    "➡️ СЕЙЧАС: "+(d.action||"нужно больше данных"),
    "💬 "+(d.reason||""),
    "🎯 Уверенность: "+Math.round(Number(d.confidence)||0)+"%",
    "🔎 OCR: "+Math.round(Number(r.ocr_confidence)||0)+"%",
    r.warning?"⚠️ "+r.warning:"",
    "",
    "🆓 Локальный OCR. OpenAI API не используется."
  ];
  return lines.filter(Boolean).join("\n");
}
function forwardedInfo(m){
  return !!(m?.forward_origin || m?.forward_date || m?.is_automatic_forward || m?.external_reply);
}
function imageFileId(m){
  if(Array.isArray(m?.photo) && m.photo.length) return m.photo[m.photo.length-1]?.file_id || null;
  if(m?.document && /^image\//i.test(String(m.document.mime_type||""))) return m.document.file_id || null;
  return null;
}
async function analyzeForwardedText(chat,text){
  const state=parseState(text);
  const decision=decide(state,100);
  relay("/bridge/state", { ...state, source: "telegram_forward", received_at: Date.now(), local_decision: decision }).catch(e => console.log("FORWARD STATE PUBLISH ERROR:", e.message));
  const lines=[
    "📨 ПЕРЕСЛАННОЕ СООБЩЕНИЕ ИЗ ИГРЫ","",
    state.balance!=null?"💰 Баланс: "+state.balance.toLocaleString("ru-RU")+" ₽":"",
    state.garage?"🚗 Гараж: "+state.garage:"",
    state.vehicle?.name?"🚘 Авто: "+state.vehicle.name:"",
    state.price!=null?"💵 Цена: "+state.price.toLocaleString("ru-RU")+" ₽":"",
    state.mileage!=null?"🛣 Пробег: "+state.mileage.toLocaleString("ru-RU")+" км":"",
    state.hp!=null?"⚙️ Мощность: "+state.hp+" л.с.":"",
    state.owners!=null?"👤 Владельцев: "+state.owners:"",
    state.plate?"🔢 Номер: "+state.plate:"",
    "",
    "➡️ СЕЙЧАС: "+decision.action,
    "💬 "+decision.reason,
    "🎯 Уверенность: "+decision.confidence+"%"
  ].filter(Boolean);
  return send(chat,lines.join("\n"));
}

async function handlePhoto(chat,photo){
  if(processingChats.has(String(chat))){
    return send(chat,"⏳ Предыдущий скриншот ещё анализируется. Дождись результата — новый запуск сейчас не нужен.");
  }
  processingChats.add(String(chat));
  try {
    const best = Array.isArray(photo) ? photo[photo.length - 1] : photo;
    if (!best || !best.file_id) throw new Error("Telegram не передал file_id");
    const chatKey=String(chat);
    const previousFile=photoFileIds.get(chatKey);
    if(previousFile && previousFile.file_id===best.file_id && Date.now()-previousFile.time<60000){
      return send(chat,"ℹ️ Этот скриншот уже был разобран. Отправь новый экран игры.");
    }
    photoFileIds.set(chatKey,{file_id:best.file_id,time:Date.now()});
    send(chat, "📥 Скриншот получил. Анализирую локально...").catch(e=>console.log("PHOTO NOTICE ERROR:",e.message));
    const bytes = await downloadTelegramFile(best.file_id);
    if (!bytes || !bytes.length) throw new Error("Telegram вернул пустой файл");
    const crypto=require("crypto");
    const fingerprint=crypto.createHash("sha256").update(bytes).digest("hex");
    const seen=photoFingerprints.get(String(chat));
    if(seen && seen.fingerprint===fingerprint && Date.now()-seen.time<60000){
      return send(chat,"ℹ️ Это тот же скриншот, который уже был разобран. Отправь новый экран игры.");
    }
    photoFingerprints.set(String(chat),{fingerprint,time:Date.now()});
    const analysis = await analyzeImage(bytes);
    const r = analysis || {};
    relay("/bridge/state", { ...r, source: "telegram_screenshot", received_at: Date.now(), local_decision: r.decision || null }).catch(e => console.log("SCREEN STATE PUBLISH ERROR:", e.message));
    const result = await analyzePhotoFree(bytes, analysis);
    return send(chat, "📸 Анализ скриншота\n\n" + result);
  } catch (e) {
    console.log("PHOTO ANALYSIS ERROR:", e && (e.stack || e.message || e));
    return send(chat, "⚠️ Анализ не выполнен.\n\nПричина: " + String(e && (e.message || e) || "неизвестная ошибка").slice(0, 700));
  } finally {
    processingChats.delete(String(chat));
  }
}

async function handle(m){
  const chat=m.chat?.id;if(!chat)return;const text=String(m.text||"").trim();
  if(text==="/start"){users.set(chat,{connected:false});return send(chat,"🚗 CarFlipCopilot\n\nЯ работаю прямо внутри Telegram. Android-приложение для общения со мной не нужно.\n\nМоя задача — смотреть состояние «Симулятора Перекупа», учитывать историю сделок и говорить одно конкретное следующее действие.\n\nНачни с «🔗 Подключить игру».");}
  if(text==="/connect")return connect(chat);if(text==="/state")return state(chat);if(text==="/advice")return advice(chat);if(text==="/probe")return probe(chat);if(text==="/bridge")return bridgeStatus(chat);if(text==="/game")return gameDebug(chat);
  if(text==="/help")return send(chat,"Команды:\n/connect — подключение игры\n/state — состояние\n/advice — что делать сейчас\n/probe — проверить связь с игрой\n/bridge — статус Telegram-моста\n/game — последнее сообщение игры и кнопки\n/help — эта справка\n\nМожно прислать скриншот текущей ситуации — бот разберёт его прямо здесь.");
  const forwarded=forwardedInfo(m);
  const forwardedImage=imageFileId(m);
  if(forwardedImage){
    handlePhoto(chat,[{file_id:forwardedImage}]).catch(e=>console.log("FORWARDED PHOTO ERROR:",e.stack||e.message||e));
    return;
  }
  if(m.photo?.length){
    handlePhoto(chat,m.photo).catch(e=>console.log("PHOTO UNHANDLED ERROR:",e.stack||e.message||e));
    return;
  }
  if(forwarded && text){
    analyzeForwardedText(chat,text).catch(e=>console.log("FORWARDED TEXT ERROR:",e.stack||e.message||e));
    return;
  }
  if(text)return send(chat,"Используй кнопки ниже или пришли скриншот игры или пересланное сообщение из игры.");
}
async function connect(chat){
  if(userBridge.configured()){
    try{
      await userBridge.ensureClient();
      if(userBridge.status().connected){
        userBridge.saveBinding(chat);
        return send(chat,"🔗 Игра уже подключена к твоему Telegram.\n\nНажми «🧪 Проверить связь с игрой» — новое подключение не требуется.");
      }
    }catch(e){
      console.log("CONNECT RESTORE CHECK:",e.message);
    }
  }
  if(CONNECT_URL||BRIDGE_PUBLIC_URL){
    const url=CONNECT_URL||(BRIDGE_PUBLIC_URL+"/connect?ticket="+encodeURIComponent(userBridge.createTicket(chat)));
    if(!userBridge.configured()){
      return send(chat,"🔗 Подключение игры\n\nАвтоматический мост сейчас не активирован: на сервере отсутствуют TELEGRAM_API_ID и TELEGRAM_API_HASH.\n\n📸 Скриншотный режим уже доступен — просто пришли экран игры или перешли сообщение из неё.\n\n🔐 API-данные не отправляй в чат.",{reply_markup:{inline_keyboard:[[{text:"📸 Использовать скриншотный режим",callback_data:"photo"}],[{text:"↩️ Назад",callback_data:"menu"}]]}});
    }
    return send(chat,"🔗 Открываю защищённое подключение.\n\nПосле авторизации мост привяжет твой Telegram-профиль к состоянию игры.",{reply_markup:{inline_keyboard:[[{text:"🎮 Подключить игру",web_app:{url}}],[{text:"🧪 Проверить связь",callback_data:"probe"}],[{text:"↩️ Назад",callback_data:"menu"}]]}});
  }
  return send(chat,"🔗 Подключение игры\n\nИгра: @"+GAME_USERNAME+"\n\nПользовательский Telegram-мост: "+(userBridge.configured()?"готов":"не настроен")+"\n\n📸 Скриншотный режим уже работает без API-данных. Пришли скриншот или перешли сообщение из игры — бот разберёт его прямо в Telegram.\n\n🔐 Не отправляй API hash, коды входа, пароль 2FA или сессию в чат.");
}
async function gameDebug(chat){
  const s=userBridge.status(),m=s.last_game_message;if(!m)return send(chat,"🎮 Пока нет сообщения от игрового бота. Сначала подключи игру и нажми «Проверить связь с игрой».");
  const buttons=m.buttons&&m.buttons.length?"\n\n🔘 Кнопки:\n"+m.buttons.map((x,i)=>(i+1)+". "+x).join("\n"):"";
  const rows=(m.buttons||[]).slice(0,8).map(label=>[{text:"▶️ "+label,callback_data:gameButtonData(label,userBridge.status()?.last_game_message?.message_id)}]);
  return send(chat,"🎮 Последнее сообщение игры:\n\n"+String(m.text||"—").slice(0,6000)+buttons,{reply_markup:{inline_keyboard:rows}});
}
async function bridgeStatus(chat){const s=userBridge.status();return send(chat,"🔗 Telegram-мост\n\nСтатус: "+(s.connected?"✅ подключён":"❌ не подключён")+"\nИгровой бот: @"+GAME_USERNAME+"\nПользователь: "+(s.username?"@"+s.username:"не определён")+(s.last_error?"\n\n⚠️ "+s.last_error:""));}
async function state(chat){try{const s=await relay("/state");return send(chat,"📊 Текущее состояние\n\n💰 Баланс: "+(s.balance??"неизвестно")+"\n🚗 Гараж: "+(s.garage??"неизвестно")+"\n🚘 Машина: "+(s.vehicle?.name||"нет данных")+"\n\nЭто данные, которые игровой мост передал relay.");}catch(e){return send(chat,"⚠️ Состояние пока недоступно: "+e.message);}}
async function advice(chat){
  try{
    const r=await relay("/telegram/advice",{chat_id:chat});
    const current=userBridge.status().last_game_message;
    const relayButtons=Array.isArray(r.game_buttons)?r.game_buttons:[];
    const observed=(current?.buttons?.length?current.buttons:relayButtons).slice(0,8);
    const sourceMessageId=current?.message_id||null;
    const ranked=buttonChoiceAnalysis(r.decision,{...r.state,...(current||{}),raw_message:current?.text||r.state?.raw_message},observed),recommended=ranked[0]?.label||null,rows=[];
    if(recommended && sourceMessageId){
      const risk=actionRisk(r.decision?.action||recommended);
      rows.push([{text:(risk?"⚠️ Подтвердить: ":"🤖 Выполнить: ")+recommended,callback_data:confirmButtonData(recommended,sourceMessageId)}]);
    }
    if(sourceMessageId){
      for(const label of observed) rows.push([{text:"▶️ "+label,callback_data:gameButtonData(label,sourceMessageId)}]);
    }
    let out=r.text||"Пока нет актуального решения. Передай состояние игры или скриншот.";
    if(recommended && sourceMessageId) out+="\n\n🤖 ЛУЧШИЙ ВЫБОР: «"+recommended+"» — "+(ranked[0]?.percent||0)+"%\n\n📊 Оценка кнопок:\n"+ranked.slice(0,5).map((x,i)=>(i+1)+". «"+x.label+"» — "+x.percent+"%").join("\n")+"\n\nНажатие выполняется только после твоего подтверждения.";
    else if(recommended) out+="\n\nℹ️ Решение построено по сохранённому состоянию игры. Кнопки можно восстановить через «🧪 Проверить связь с игрой» или /game.";
    return send(chat,out,rows.length?{reply_markup:{inline_keyboard:rows}}:{});
  }catch(e){return send(chat,"⚠️ Помощник пока не получил состояние игры: "+e.message);}
}
async function probe(chat){
  if(!userBridge.configured()){
    return send(chat,"🧪 Проверка связи\n\nℹ️ Автоматический мост пока не настроен: для входа в твой личный Telegram нужен TELEGRAM_API_ID + TELEGRAM_API_HASH.\n\n📸 Но бот уже работает без них: пришли скриншот игры или перешли сообщение из игры — я распознаю состояние и дам одно конкретное следующее действие.\n\n🔐 API-данные не нужно отправлять мне в чат.");
  }
  try{
    await userBridge.ensureClient();
    const s=userBridge.status();
    if(!s.connected){
      return send(chat,"🧪 Проверка связи\n\n❌ Сохранённой Telegram-сессии нет. Однократно нажми «🔗 Подключить игру» и заверши вход. После этого бот больше не должен запрашивать подключение после перезапуска.");
    }
    // The probe comes from the real bot chat, so make this chat the active
    // notification target even if an older connection ticket was used.
    userBridge.saveBinding(chat);
    await userBridge.sendGameMessage("/start");
    pendingGameProbes.set(chat,Date.now());
    return send(chat,"🧪 Проверка связи\n\n✅ Запрос /start отправлен в @"+GAME_USERNAME+" от твоей подключённой Telegram-сессии.\n\nЖду ответ игры и обновление состояния.");
  }catch(e){
    return send(chat,"⚠️ Не удалось проверить связь с игрой.\n\nПричина: "+String(e.message||e).slice(0,500));
  }
}
async function callback(q){
  const chat=q.message?.chat?.id,data=String(q.data||"");try{await tg("answerCallbackQuery",{callback_query_id:q.id});}catch{}
  if(data.startsWith("confirmbtn:")||data.startsWith("gamebtn:")){
    const prefix=data.startsWith("confirmbtn:")?"confirmbtn":"gamebtn",ref=gameButtonRef(data,prefix),s=userBridge.status(),latest=s.last_game_message;
    if(!ref)return send(chat,"⚠️ Кнопка повреждена. Нажми /game или /advice ещё раз.");
    if(!latest)return send(chat,"⚠️ Нет актуального экрана игры. Нажми /game или /advice ещё раз.");
    if(!ref.legacy&&String(latest.message_id)!==String(ref.messageId))return send(chat,"⚠️ Экран игры изменился. Обнови кнопки через /game или /advice.");
    let label=null;
    if(ref.legacy) label=(latest.buttons||[]).find(x=>gameButtonKey(x)===ref.key);
    else { try { label=await userBridge.getGameButton(ref.messageId,ref.key); } catch(e) { console.log("GAME BUTTON LOOKUP ERROR:",e.message); } }
    if(!label)return send(chat,"⚠️ Эта кнопка больше отсутствует на исходном экране игры. Обнови кнопки.");
    try{await userBridge.clickGameButton(label,ref.messageId);return send(chat,(prefix==="confirmbtn"?"✅ Выполнено в игре: ":"✅ Нажал: ")+label);}catch(e){return send(chat,"❌ Не удалось выполнить «"+label+"»: "+e.message);}
  }
  if(data==="connect")return connect(chat);if(data==="state")return state(chat);if(data==="advice")return advice(chat);if(data==="probe")return probe(chat);if(data==="photo")return send(chat,"📸 Просто отправь сюда скриншот игры.");if(data==="menu")return send(chat,"Главное меню:");
}
async function processUpdate(u){
  if(!u || typeof u!=="object") return;
  if(u.update_id!=null) offset=Math.max(offset,Number(u.update_id)+1);
  if(u.callback_query) return callback(u.callback_query);
  if(u.message) return handle(u.message);
}
async function setupWebhook(){
  if(!BOT_TOKEN){console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN missing");return false;}
  const base=(BRIDGE_PUBLIC_URL||process.env.RENDER_EXTERNAL_URL||"").replace(/\/$/,"");
  if(!base){console.log("Telegram webhook disabled: public URL missing");return false;}
  const url=base+"/telegram/webhook";
  try{
    await tg("deleteWebhook",{drop_pending_updates:false});
    await tg("setWebhook",{url,allowed_updates:["message","callback_query"],drop_pending_updates:false});
    const info=await tg("getWebhookInfo",{});
    webhookEnabled=!!info?.url;
    console.log("Telegram webhook:",webhookEnabled?info.url:"not enabled", "pending:",info?.pending_update_count??0);
    return webhookEnabled;
  }catch(e){
    console.log("Telegram webhook setup error:",e.message);
    return false;
  }
}
async function loop(){
  if(polling)return;polling=true;
  const ok=await setupWebhook();
  if(ok) return;
  console.log("Telegram bot fallback polling is disabled to prevent 409 conflicts.");
}
userBridge.webhookHandler=processUpdate;
console.log("Telegram bridge env:",{apiIdPresent:!!process.env.TELEGRAM_API_ID,apiHashPresent:!!process.env.TELEGRAM_API_HASH});
if(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH)userBridge.ensureClient().then(()=>console.log("Telegram user bridge initialized")).catch(e=>console.log("Telegram user bridge init:",e.message));
registerBotCommands().catch(e=>console.log("Telegram command registration:",e.message));
warmup().then(ok=>console.log("OCR worker warmup:",ok?"ready":"failed")).catch(e=>console.log("OCR warmup error:",e.message));
loop();
