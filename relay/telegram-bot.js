const https = require("https");
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:32,maxFreeSockets:8,timeout:60000,freeSocketTimeout:15000});
const { TelegramUserBridge, createConnectServer } = require("./user-session-bridge");
const { analyzeImage, parseState, decide, warmup } = require("./free-analyzer");
const { rankButtons, recordScreen, recordClick } = require("./button-strategy");
const { recordScreen: recordMemoryScreen, recordAction: recordMemoryAction, recent: recentMemory } = require("./game-memory");
const { recordTransition: recordEconomyTransition, summary: economySummary, currentVehicleEconomics } = require("./game-economy");
const { buildStrategy, parseContract } = require("./strategy-engine");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const RELAY_TOKEN = process.env.COPILOT_TOKEN || "";
const RELAY_URL = process.env.RELAY_URL || "";
const GAME_USERNAME = process.env.GAME_BOT_USERNAME || "m0dsbeamngbot";
const CONNECT_URL = process.env.GAME_CONNECT_URL || "";
const BRIDGE_PUBLIC_URL = String(process.env.BRIDGE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/,"");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8787);
const API = "https://api.telegram.org/bot" + BOT_TOKEN;
const WEBHOOK_SECRET = BOT_TOKEN ? require("crypto").createHash("sha256").update(BOT_TOKEN).digest("hex") : "";

let offset=0,polling=false,webhookEnabled=false;
process.on("unhandledRejection",e=>console.log("UNHANDLED REJECTION:",e?.stack||e?.message||e));
process.on("uncaughtException",e=>console.log("UNCAUGHT EXCEPTION:",e?.stack||e?.message||e));
const users=new Map(),pendingGameProbes=new Map();
const activeGameChats=new Map();
const gameActionChats=new Set();
const gameRenderQueues=new Map();
const lastRenderedGameFingerprints=new Map();
const replyKeyboardClearedChats=new Set();
const photoFingerprints=new Map();
const photoFileIds=new Map();
const processingChats=new Set();
const updateQueues=new Map();
const BOT_REQUEST_TIMEOUT=15000;

function withTimeout(promise,ms,label){
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+" timeout after "+ms+"ms")),ms);})
  ]).finally(()=>clearTimeout(timer));
}

function enqueueChatUpdate(chatId,task){
  const key=String(chatId||"global");
  const previous=updateQueues.get(key)||Promise.resolve();
  const current=previous.catch(()=>{}).then(()=>task());
  updateQueues.set(key,current);
  return current.finally(()=>{
    if(updateQueues.get(key)===current)updateQueues.delete(key);
  });
}

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

  const raw=String(state?.raw_message||state?.raw_text||"").toLowerCase();
  const action=String(decision?.action||"").toLowerCase();
  if(!action || /нет подтверждённого действия|пришли другой скриншот|определи текущий экран/.test(action)) return [];

  // Кнопка считается рекомендованной только при прямом доказательстве
  // на самом экране. Наличие денег, гаража, машины или одной подходящей
  // по названию кнопки не является доказательством выгодности действия.
  const negativeAction=/^не\s+(покупай|бери|продавай|продавай|ремонтируй|трать)/i.test(action);
  if(negativeAction)return [];

  const explicitInstruction =
    /(?:нажми|выбери|нужно\s+нажать|следует\s+нажать|рекомендуется\s+нажать|жми)\s+[«"“]?([^»"”\n]+)[»"”]?/i.exec(raw);

  if(!explicitInstruction)return [];

  const instructed=normalizeButtonText(explicitInstruction[1]);
  const matches=list.filter(label=>normalizeButtonText(label)===instructed);
  if(matches.length!==1)return [];

  const label=matches[0];
  return [{
    label,
    type:classifyGameButton(label),
    percent:100,
    reason:"игра прямо указала эту кнопку в текущем экране"
  }];
}

function buttonScoreText(ranked){
  if(!ranked.length)return "";
  return ranked.map((x,i)=>(i===0?"⭐ ":"")+String(i+1)+". «"+x.label+"» — оценка модели "+x.percent+"/100\n   └ "+x.reason).join("\n");
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
  if(activeGameChats.get(String(chat))){
    // The game screen is rendered by the active game-mode pipeline.
    // Never send a second standalone event for the same update.
    if(gameActionChats.has(String(chat))) return;
    try{const id=activeGameChats.get(String(chat)+"_message_id");if(id)await renderGame(chat,{messageId:id});else await renderGame(chat);}catch(e){console.log("GAME SCREEN PUSH ERROR:",e.message);}
    return;
  }
  // If the game sends a real screen with buttons before the user opens
  // "Играть", render that screen directly. Sending a separate "Новое событие"
  // first creates the duplicate two-message output seen in Telegram.
  const hasScreenText=String(state.raw_message||state.raw_text||"").trim().length>0;
  if((Array.isArray(state.buttons) && state.buttons.length) || hasScreenText){
    try{await renderGame(chat);}catch(e){console.log("GAME SCREEN PUSH ERROR:",e.message);}
    return;
  }
  const hasParsedState=state.balance!=null || state.garage!=null || state.vehicle?.name || state.vehicle?.price!=null;
  // Ignore empty bridge heartbeats/events. They are not useful game screens and
  // must not replace the main menu with a misleading "Баланс: — / Гараж: —".
  if(!hasParsedState)return;
  const fingerprint=JSON.stringify({balance:state.balance,garage:state.garage,vehicle:state.vehicle,raw_message:state.raw_message});
  if(fingerprint===lastBridgeFingerprint)return;lastBridgeFingerprint=fingerprint;
  if(Date.now()-lastBridgeNotice<5000)return;lastBridgeNotice=Date.now();
  const lines=["🎮 Новое событие из игры","","💰 Баланс: "+(state.balance??"—"),"🚗 Гараж: "+(state.garage??"—")];
  if(state.vehicle?.name)lines.push("🚘 "+state.vehicle.name);
  if(state.vehicle?.price!=null)lines.push("💵 Цена: "+state.vehicle.price);
  const autoDecision=state.local_decision||decide(state,90);
  const strategyState=Object.assign({},state,{raw_message:state.raw_message||state.raw_text||"",raw_text:state.raw_text||state.raw_message||""});
  const ranked=await rankButtons(chat,strategyState,state.buttons||[]);
  const strategy=buildStrategy(strategyState,ranked,await economySummary(chat,120));
  const recommended=strategy.actionEvidence ? ranked[0]?.label : null;
  if(recommended){
    lines.push("","🧠 АНАЛИЗ КНОПОК","👉 ЧТО ДЕЛАТЬ СЕЙЧАС: нажать «"+recommended+"»","   Оценка модели: "+ranked[0].percent+"/100","   Почему: "+ranked[0].reason);
    lines.push("📊 ВСЕ КНОПКИ:\n"+buttonScoreText(ranked));
  }else if(ranked.length){
    lines.push("","🧠 АНАЛИЗ КНОПОК","👉 ЧТО ДЕЛАТЬ СЕЙЧАС: не нажимать наугад","   Текущий экран не содержит достаточного подтверждения для конкретного действия.","📊 ВСЕ КНОПКИ:\n"+buttonScoreText(ranked));
  }else lines.push("","Нажми «🧠 Что делать сейчас», чтобы получить решение ИИ.");
  try{await send(chat,lines.join("\n"));}catch(e){console.log("BRIDGE NOTICE ERROR:",e.message);}
}

const userBridge=new TelegramUserBridge({
  apiId:process.env.TELEGRAM_API_ID,apiHash:process.env.TELEGRAM_API_HASH,gameUsername:GAME_USERNAME,
  relayUrl:RELAY_URL,relayToken:RELAY_TOKEN,publicUrl:BRIDGE_PUBLIC_URL,
  onState:notifyBridgeState,
  sessionFile:process.env.TELEGRAM_SESSION_FILE||require("path").join(process.cwd(),"data","telegram-user-session.txt")
});
createConnectServer(userBridge,BRIDGE_PORT,{webhookSecret:WEBHOOK_SECRET});

async function registerBotCommands(){
  const commands=[
    {command:"start",description:"Открыть главное меню"},
    {command:"connect",description:"Подключить игру"},
    {command:"state",description:"Показать состояние игры"},
    {command:"advice",description:"Что делать сейчас"},
    {command:"game",description:"Открыть игру в Telegram"},
    {command:"probe",description:"Проверить связь с игрой"},
    {command:"help",description:"Помощь и список команд"}
  ];
  for(let attempt=1;attempt<=5;attempt++){
    try{
      await tg("setMyCommands",{commands,scope:{type:"all_private_chats"}});
      console.log("Telegram commands registered");
      return true;
    }catch(e){
      console.log("COMMANDS REGISTER ERROR attempt="+attempt+":",e.stack||e.message||e);
      if(attempt<5) await new Promise(r=>setTimeout(r,Math.min(5000,attempt*1000)));
    }
  }
  return false;
}
function tg(method,body){return new Promise((resolve,reject)=>{
  const data=JSON.stringify(body||{}),u=new URL(API+"/"+method);
  const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},res=>{
    let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{const j=JSON.parse(s);if(!j.ok)return reject(new Error(j.description||"Telegram API error"));resolve(j.result);}catch(e){reject(e);}});
  });req.on("error",reject);req.setTimeout(BOT_REQUEST_TIMEOUT,()=>req.destroy(new Error("Telegram API timeout")));req.write(data);req.end();
});}function tgPhoto(chat_id,buffer,caption,reply_markup){
  return new Promise((resolve,reject)=>{
    const boundary="----CarFlipCopilot"+require("crypto").randomBytes(8).toString("hex");
    const parts=[],add=(n,v)=>parts.push(Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+n+"\"\r\n\r\n"+String(v)+"\r\n"));
    add("chat_id",chat_id);add("caption",caption);if(reply_markup)add("reply_markup",JSON.stringify(reply_markup));
    parts.push(Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"game.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"),buffer,Buffer.from("\r\n--"+boundary+"--\r\n"));
    const body=Buffer.concat(parts),u=new URL(API+"/sendPhoto");
    const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",agent:keepAliveAgent,headers:{"content-type":"multipart/form-data; boundary="+boundary,"content-length":body.length}},res=>{let s="";res.on("data",d=>s+=d);res.on("end",()=>{try{const j=JSON.parse(s);if(!j.ok)return reject(new Error(j.description||"Telegram sendPhoto error"));resolve(j.result);}catch(e){reject(e);}});});
    req.on("error",reject);req.setTimeout(15000,()=>req.destroy(new Error("Telegram sendPhoto timeout")));req.write(body);req.end();
  });
}
function kb(chatId){
  const rows=[
    [{text:"🎮 Играть"}],
    [{text:"🧠 Что делать сейчас"}],
    [{text:"📊 Состояние"},{text:"📜 История"},{text:"💰 Экономика"}],
    [{text:"📸 Анализ скрина"}],
    [{text:"🔗 Подключить игру"}],
    [{text:"🧪 Проверить связь с игрой"}]
  ];
  const connectBase=CONNECT_URL||(BRIDGE_PUBLIC_URL?BRIDGE_PUBLIC_URL+"/connect":"");
  const connectUrl=connectBase&&chatId ? connectBase+(connectBase.includes("?")?"&":"?")+"ticket="+encodeURIComponent(userBridge.createTicket(chatId)) : "";
  if(connectUrl)rows.push([{text:"🎮 Открыть подключение",web_app:{url:connectUrl}}]);
  // Единственная служебная кнопка в игровом режиме — возврат назад.
  rows.push([{text:"⬅️ Назад"}]);
  return {keyboard:rows,resize_keyboard:true,one_time_keyboard:false,is_persistent:true};
}
async function send(chat_id,text,extra={}){
  const payload=Object.assign({
    chat_id,text,
    reply_markup:kb(chat_id),
    disable_web_page_preview:true
  },extra);
  // While the user is in game mode, every ordinary bot message must preserve
  // the game ReplyKeyboard. A single fallback/error message must not switch
  // Telegram back to the main menu keyboard.
  if(activeGameChats.get(String(chat_id)) && !Object.prototype.hasOwnProperty.call(extra,"reply_markup")){
    const latest=userBridge.status().last_game_message;
    if(latest) payload.reply_markup=await gameKeyboard(latest);
  }
  return tg("sendMessage",payload);
}
async function relay(path,body={}){if(!RELAY_URL)throw new Error("RELAY_URL не настроен");const u=new URL(RELAY_URL+path),data=JSON.stringify(body);
  return new Promise((resolve,reject)=>{const req=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","authorization":"Bearer "+RELAY_TOKEN,"content-length":Buffer.byteLength(data)}},res=>{let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{resolve(JSON.parse(s))}catch{resolve({raw:s})}})});req.on("error",reject);req.setTimeout(BOT_REQUEST_TIMEOUT,()=>{req.destroy(new Error("Relay timeout"));});req.write(data);req.end();});
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
    "🔎 Надёжность распознавания: "+decision.confidence+"%"
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
  if(text==="/help")return send(chat,"Команды:\n/connect — подключение игры\n/state — состояние\n/advice — что делать сейчас\n/probe — проверить связь с игрой\n/bridge — статус Telegram-моста\n/game — открыть игру прямо в чате\n/help — эта справка\n\nМожно прислать скриншот текущей ситуации — бот разберёт его прямо здесь.");
  // Main-menu action must be handled before game-mode routing. If a game screen
  // arrived automatically, activeGameChats may already be set; in that case
  // pressing «🎮 Играть» must still open/refresh the game screen, not be sent
  // to the game bot as an unknown game button.
  if(text==="🎮 Играть"){ return gameDebug(chat); }
  if(text==="💰 Экономика"){
    const e=await economySummary(chat,200);
    const live=userBridge.status();
    const liveText=String(live?.last_game_message?.text||live?.last_game_message?.raw_text||"");
    const offerMatch=liveText.match(/(?:предлож(?:ение|ил)|цена продажи|купит за|купят за)[^0-9]{0,30}([0-9][0-9 .]{2,})/i);
    const offer=offerMatch?Number(offerMatch[1].replace(/\s/g,"")):null;
    const liveEco=currentVehicleEconomics(live,offer,0);
    if(!e.transactions.length)return send(chat,"💰 ЭКОНОМИКА\n\nИстория финансовых изменений пока пуста.");
    const k=e.byKind||{};
    const lines=["💰 ЭКОНОМИКА","",
      "📈 Чистое изменение баланса: "+Math.round(e.net)+" ₽",
      "📤 Расходы: "+Math.round(e.spent)+" ₽",
      "📥 Поступления: "+Math.round(e.received)+" ₽","",
      "🛒 Покупки: "+Math.round(k.purchase||0)+" ₽",
      "💵 Продажи: "+Math.round(k.sale||0)+" ₽",
      "🔄 Продления: "+Math.round(k.renewal||0)+" ₽",
      "🔧 Ремонт: "+Math.round(k.repair||0)+" ₽",
      "⚙️ Тюнинг: "+Math.round(k.tuning||0)+" ₽",
      "🔢 Номера: "+Math.round((k.plate||0)+(k.plate_removal||0))+" ₽"];
    if(Array.isArray(e.vehicles)&&e.vehicles.length){
      lines.push("","🚗 СЕБЕСТОИМОСТЬ И ПРИБЫЛЬ");
      e.vehicles.slice(0,8).forEach((v,i)=>{
        lines.push("",(i+1)+". "+(v.vehicle_name||"Автомобиль")+(v.plate?" · "+v.plate:""));
        lines.push("   Себестоимость: "+Math.round(v.full_cost||0)+" ₽");
        if(v.status==="sold") lines.push("   Реализовано: "+Math.round(v.realized_proceeds||0)+" ₽","   Комиссии: "+Math.round(v.fees||0)+" ₽","   Итог: "+Math.round(v.realized_profit||0)+" ₽");
        else lines.push("   Вложено дополнительно: "+Math.round(v.extra_cost||0)+" ₽","   Статус: в гараже");
      });
    }
    if(liveEco?.sale){
      lines.push("","🎯 ТЕКУЩЕЕ ПРЕДЛОЖЕНИЕ");
      lines.push("Предложение: "+Math.round(liveEco.sale.offer)+" ₽");
      lines.push("Себестоимость: "+Math.round(liveEco.sale.cost)+" ₽");
      lines.push("Разница до комиссии: "+Math.round(liveEco.sale.offer-liveEco.sale.cost)+" ₽");
      lines.push("Расчётная комиссия: "+Math.round(liveEco.sale.fee)+" ₽");
      lines.push("Расчётный результат: "+Math.round(liveEco.sale.profit)+" ₽");
    }
    return send(chat,lines.join("\n"));
  }
  if(text==="📜 История"){
    const rows=await recentMemory(chat,20);
    if(!rows.length) return send(chat,"📜 ИСТОРИЯ\n\nИстория действий пока пуста. Сначала подключи игру и выполни действие.");
    const lines=["📜 ИСТОРИЯ ПОСЛЕДНИХ ДЕЙСТВИЙ",""]; 
    rows.slice(0,12).forEach((r,i)=>{
      const before=String(r.before_text||"").replace(/\\s+/g," ").slice(0,90);
      const after=String(r.after_text||"").replace(/\\s+/g," ").slice(0,90);
      lines.push((i+1)+". 👉 "+String(r.button||"—")+" "+(r.changed?"→ экран изменился":"→ экран не изменился"));
      lines.push("   До: "+before);
      if(after) lines.push("   После: "+after);
    });
    return send(chat,lines.join("\\n"));
  }
  // ReplyKeyboard labels arrive as ordinary text and are handled directly.
  if(activeGameChats.get(String(chat))){
    const latest=userBridge.status().last_game_message;
    const labels=Array.isArray(latest?.buttons)?latest.buttons:[];
    if(text==="⬅️ Назад"){
      const screenId=activeGameChats.get(String(chat)+"_message_id");
      activeGameChats.delete(String(chat));
      activeGameChats.delete(String(chat)+"_message_id");
      lastRenderedGameFingerprints.delete(String(chat));
      if(screenId){
        try{await tg("deleteMessage",{chat_id:chat,message_id:screenId});}catch(e){console.log("GAME SCREEN BACK DELETE ERROR:",e.message);}
      }
      return send(chat,"Главное меню:");
    }
    if(text==="🔄 Обновить игру") return renderGame(chat);
    if(text==="🧠 Стратегия") return advice(chat);
    if(text==="📊 Состояние") return state(chat);
    if(text==="🚪 Выйти из игры"){
      const screenId=activeGameChats.get(String(chat)+"_message_id");
      activeGameChats.delete(String(chat));
      activeGameChats.delete(String(chat)+"_message_id");
      if(screenId){
        try{await tg("deleteMessage",{chat_id:chat,message_id:screenId});}catch(e){console.log("GAME SCREEN EXIT DELETE ERROR:",e.message);}
      }
      return send(chat,"🚪 Игровой режим закрыт.");
    }
    const target=labels.find(x=>String(x).trim()===text.trim()) || text;
    if(latest?.message_id && text && !["⬅️ Назад","🔄 Обновить игру","🚪 Выйти из игры"].includes(text)){
      gameActionChats.add(String(chat));
      let backgroundGameWait=false;
      try{
        // Do not require the cached button list to contain the label: the
        // game can update its markup a moment before our local state does.
        const beforeState=Object.assign({},userBridge.status());
        await userBridge.clickGameButton(target,latest.message_id);
        recordClick(chat,latest.text||"",latest.buttons||[],target,userBridge.status().last_game_message?.text||"").catch(e=>console.log("BUTTON STRATEGY CLICK ERROR:",e.message));
        // Do not make the user wait 10 seconds for a slow game response.
        // If the game answers later, the background waiter will refresh the screen.
        const updated=await waitForGameUpdate(latest.message_id,latest.text||"",latest.buttons||[],1200);
        if(updated){
          const afterState=Object.assign({},userBridge.status());
          recordMemoryAction(chat,beforeState,target,afterState).catch(e=>console.log("GAME MEMORY ACTION ERROR:",e.message));
          recordEconomyTransition(chat,beforeState,target,afterState).catch(e=>console.log("GAME ECONOMY ERROR:",e.message));
          return renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
        }
        const screenId=activeGameChats.get(String(chat)+"_message_id");
        backgroundGameWait=true;
        setTimeout(async()=>{
          try{
            const later=await waitForGameUpdate(latest.message_id,latest.text||"",latest.buttons||[],8000);
            if(later){
              const afterState=Object.assign({},userBridge.status());
              recordMemoryAction(chat,beforeState,target,afterState).catch(e=>console.log("GAME MEMORY DELAYED ACTION ERROR:",e.message));
              recordEconomyTransition(chat,beforeState,target,afterState).catch(e=>console.log("GAME ECONOMY DELAYED ACTION ERROR:",e.message));
              await renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
            }
          }catch(e){console.log("GAME LATE UPDATE ERROR:",e.message);}
          finally{gameActionChats.delete(String(chat));}
        },0);
        return renderGame(chat,{messageId:screenId});
      }catch(e){
        // Never fall through to the main-menu fallback while game mode is active.
        return renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
      }finally{
        if(!backgroundGameWait)gameActionChats.delete(String(chat));
      }
    }
    // Any stale/unrecognized text in game mode must keep the game keyboard.
    return renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
  }
  if(text==="🧠 Что делать сейчас"){ return advice(chat); }
  if(text==="📊 Состояние"){ return state(chat); }
  if(text==="📸 Анализ скрина"){ return send(chat,"📸 Пришли скриншот текущей ситуации из игры."); }
  if(text==="🔗 Подключить игру"){ return connect(chat); }
  if(text==="🧪 Проверить связь с игрой"){ return probe(chat); }
  if(text==="🎮 Открыть подключение"){ return connect(chat); }
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
      return send(chat,"🔗 Подключение игры\n\nАвтоматический мост сейчас не активирован: на сервере отсутствуют TELEGRAM_API_ID и TELEGRAM_API_HASH.\n\n📸 Скриншотный режим уже доступен — просто пришли экран игры или перешли сообщение из неё.\n\n🔐 API-данные не отправляй в чат.");
    }
    return send(chat,"🔗 Открываю защищённое подключение.\n\nПосле авторизации мост привяжет твой Telegram-профиль к состоянию игры.");
  }
  return send(chat,"🔗 Подключение игры\n\nИгра: @"+GAME_USERNAME+"\n\nПользовательский Telegram-мост: "+(userBridge.configured()?"готов":"не настроен")+"\n\n📸 Скриншотный режим уже работает без API-данных. Пришли скриншот или перешли сообщение из игры — бот разберёт его прямо в Telegram.\n\n🔐 Не отправляй API hash, коды входа, пароль 2FA или сессию в чат.");
}
async function gameKeyboard(message){
  // In game mode the lower ReplyKeyboard must contain only the real buttons
  // exposed by the current game screen. Bot utility controls are intentionally
  // kept out of the game panel to avoid clutter and accidental game clicks.
  const labels=[...new Set((message?.buttons||[]).map(x=>String(x||"").trim()).filter(Boolean))];
  const rows=[];
  for(let i=0;i<labels.length;i+=2){
    const row=[{text:labels[i]}];
    if(labels[i+1])row.push({text:labels[i+1]});
    rows.push(row);
  }
  // Only one bot navigation control remains in the game panel: Back.
  rows.push([{text:"⬅️ Назад"}]);
  return {keyboard:rows,resize_keyboard:true,one_time_keyboard:false,is_persistent:true};
}
async function renderGameNow(chat,options={}){
  const s=userBridge.status();
  const lastGameScreen=s.last_game_message;
  const hasUsableGameScreen=!!(lastGameScreen && (
    String(lastGameScreen.text||"").trim() ||
    (Array.isArray(lastGameScreen.buttons) && lastGameScreen.buttons.length)
  ));
  // Do not treat an empty/stale bridge event as a game screen. On explicit
  // "Играть" we request the current screen when the bridge has no usable one.
  if(!hasUsableGameScreen && userBridge.configured() && s.connected){
    try{userBridge.saveBinding(chat);await userBridge.sendGameMessage("/start");}catch(e){return send(chat,"🎮 ИГРА\n\n❌ Не удалось получить экран игры:\n"+String(e.message||e).slice(0,700));}
  }
  const latest=userBridge.status().last_game_message;
  if(!latest)return send(chat,"🎮 ИГРА\n\n⚠️ Игра ещё не передала экран. Подключи игру и нажми «🧪 Проверить связь с игрой».");
  activeGameChats.set(String(chat),true);
  // One visible screen per unique game state. Telegram/game events and a button click can both request a render.
  const gameFingerprint=JSON.stringify({text:String(latest.text||""),buttons:Array.isArray(latest.buttons)?latest.buttons:[]});
  const currentMessageId=activeGameChats.get(String(chat)+"_message_id");
  if(!options.force && lastRenderedGameFingerprints.get(String(chat))===gameFingerprint && currentMessageId){
    return {message_id:currentMessageId,deduplicated:true};
  }
  // The game screen already contains text; parse it before asking the decision engine.
  // Passing the raw bridge object directly makes decide() miss raw_text and fall back to OCR advice.
  const parsedGame=parseState(String(latest.text||""));
  const decision=decide(Object.assign({},parsedGame,{raw_text:parsedGame.raw_text,raw_message:latest.text,buttons:latest.buttons}),90);
  const strategyState=Object.assign({},parsedGame,{raw_text:parsedGame.raw_text,raw_message:latest.text,buttons:latest.buttons||[]});
  const ranked=await rankButtons(chat,strategyState,latest.buttons||[]);
  const economy=await economySummary(chat,120);
  const strategy=buildStrategy(strategyState,ranked,economy);
  recordScreen(chat,latest.text,latest.buttons||[]).catch(e=>console.log("BUTTON STRATEGY SCREEN ERROR:",e.message));
  recordMemoryScreen(chat,latest).catch(e=>console.log("GAME MEMORY SCREEN ERROR:",e.message));
  const screenConfidence=ranked.length ? 100 : Math.round(Number(decision.confidence)||0);
  const rawGameText=String(latest.text||"—");
  const adviceLines=["🎮 ИГРА","",""+rawGameText.slice(0,7000),"","🧠 КАК ПОСТУПИТЬ: "+(ranked.length?"АНАЛИЗ КНОПОК":"НЕТ КНОПОК"),"🔎 Распознавание кнопок: "+screenConfidence+"%"];
  if(ranked.length){
    adviceLines.push("💡 Приоритет — относительная стратегическая оценка, а не вероятность исхода. Учитываются текущий экран, история игры и финансовый контекст.");
    if(strategy.actionable){
      adviceLines.push("","👉 ЧТО ДЕЛАТЬ СЕЙЧАС: нажать «"+ranked[0].label+"»","   Оценка модели: "+ranked[0].percent+"/100","   Почему: "+ranked[0].reason);
    }else{
      adviceLines.push("","👉 ЧТО ДЕЛАТЬ СЕЙЧАС: не нажимать наугад","   Текущий экран не подтверждает полезное действие. Сначала открой раздел, где есть конкретная сделка, покупка, продажа или другое действие.");
    }
    adviceLines.push("📊 СРАВНЕНИЕ КНОПОК:\n"+buttonScoreText(ranked));
    const riskLevel=(risk)=>{
      const n=Number(risk)||0;
      return n>=70?"🔴 высокий":n>=45?"🟠 средний":"🟢 низкий";
    };
    const actionLines=strategy.alternatives.map(x=>{
      const blocked=x.contractBlocked?" ⛔ УСЛОВИЯ КОНТРАКТА":"";
      return "• «"+x.label+"»\n  ├─ Риск: "+riskLevel(x.risk)+" ("+x.risk+"/100)"+blocked+"\n  └─ Если нажать: "+x.scenario;
    });
    if(actionLines.length)adviceLines.push("🔎 ЧТО ПРОИЗОЙДЁТ ПРИ НАЖАТИИ:\n"+actionLines.join("\n"));
    if(strategy.historyCount)adviceLines.push("📜 ИСТОРИЯ: учтено действий — "+strategy.historyCount+". Повторения: "+Object.entries(strategy.historyByAction).map(([k,v])=>k+" ×"+v).join(", "));
    const top=strategy.alternatives.find(x=>x.label===ranked[0].label);
    if(top){
      adviceLines.push("⚠️ Риск действия: "+top.risk+"%"+(top.reasons.length?"\n   └ "+top.reasons.join("; "):""));
      adviceLines.push("🔮 ЕСЛИ НАЖАТЬ: "+top.scenario);
    }
  }else if(decision.reason){
    adviceLines.push("💬 "+decision.reason);
  }
  if(strategy.economics){
    adviceLines.push("","💰 ЭКОНОМИКА СЦЕНАРИЯ: "+Math.round(strategy.economics.delta).toLocaleString("ru-RU")+" ₽ до комиссии");
  }
  if(strategy.contract){
    const parts=[];
    if(strategy.contract.reward!=null)parts.push("награда "+Math.round(strategy.contract.reward).toLocaleString("ru-RU")+" ₽");
    if(strategy.contract.maxPrice!=null)parts.push("лимит "+Math.round(strategy.contract.maxPrice).toLocaleString("ru-RU")+" ₽");
    if(strategy.contract.minHp!=null)parts.push("мощность от "+strategy.contract.minHp+" л.с.");
    adviceLines.push("📋 КОНТРАКТ: "+(parts.length?parts.join(", "):"условия распознаны"));
    if(strategy.contractFit?.checks?.length){
      const fitText=strategy.contractFit.checks.map(x=>{
        const status=x.ok===true?"✅":x.ok===false?"❌":"❔";
        const actual=x.actual!=null?(" сейчас "+x.actual):" не распознано";
        const required=x.required!=null?(" / нужно "+x.required):"";
        return status+" "+x.name+actual+required;
      }).join("; ");
      adviceLines.push("🧾 СООТВЕТСТВИЕ КОНТРАКТУ: "+fitText);
    }
  }
  if(strategy.warnings.length)adviceLines.push("⚠️ "+strategy.warnings.join("\n⚠️ "));
  // Telegram sendMessage has a 4096-character limit. Keep the full game screen
  // logic, but never let a verbose strategy report break delivery.
  const text=adviceLines.join("\n").slice(0,3900);
  const markup=await gameKeyboard(latest);
  const messageId=options.messageId||activeGameChats.get(String(chat)+"_message_id");

  // Обновление игрового экрана должно редактировать уже существующее
  // сообщение, а не создавать новое сообщение после каждого обновления.
  if(messageId){
    try{
      const edited=await tg("editMessageText",{
        chat_id:chat,
        message_id:messageId,
        text:text,
        reply_markup:markup,
        disable_web_page_preview:true
      });
      activeGameChats.set(String(chat)+"_message_id",messageId);
      lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
      return edited;
    }catch(e){
      const msg=String(e.message||"");
      // Если текущее сообщение содержит фотографию, Telegram не позволяет
      // заменить caption на text. Редактируем caption того же сообщения.
      if(/there is no text in the message|message can't be edited|text.*message/i.test(msg)){
        try{
          const edited=await tg("editMessageCaption",{
            chat_id:chat,
            message_id:messageId,
            caption:text.slice(0,1024),
            reply_markup:markup
          });
          activeGameChats.set(String(chat)+"_message_id",messageId);
          lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
          return edited;
        }catch(captionError){
          const captionMsg=String(captionError.message||"");
          if(!/message is not modified/i.test(captionMsg)) console.log("GAME SCREEN EDIT ERROR:",captionMsg);
        }
      }else if(!/message is not modified/i.test(msg)){
        console.log("GAME SCREEN EDIT ERROR:",msg);
      }
      if(/message is not modified/i.test(msg)){
        lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
        return {message_id:messageId,deduplicated:true};
      }
    }
  }

  let sent=null;
  try {
    const image=await Promise.race([userBridge.getGameMedia(latest.message_id),new Promise(resolve=>setTimeout(()=>resolve(null),700))]);
    if(image) sent=await tgPhoto(chat,image,text.slice(0,1000),markup);
  } catch(e) { console.log("GAME PHOTO SEND ERROR:",e.message); }
  if(!sent) sent=await send(chat,text,{reply_markup:markup});
  if(sent?.message_id){
    activeGameChats.set(String(chat)+"_message_id",sent.message_id);
    lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
  }
  return sent;
}
async function renderGame(chat,options={}){
  const key=String(chat);
  const previous=gameRenderQueues.get(key)||Promise.resolve();
  let release;  const current=new Promise(resolve=>{release=resolve;});
  gameRenderQueues.set(key,current);
  try{
    await previous.catch(()=>{});
    return await renderGameNow(chat,options);
  }finally{
    release();
    if(gameRenderQueues.get(key)===current) gameRenderQueues.delete(key);
  }
}
async function waitForGameUpdate(previousId,previousText="",previousButtons=[],timeoutMs=4500){
  const started=Date.now();
  const oldText=String(previousText||"");
  const oldButtons=JSON.stringify(previousButtons||[]);
  while(Date.now()-started<timeoutMs){
    const m=userBridge.status().last_game_message;
    if(m){
      const changedId=String(m.message_id)!==String(previousId||"");
      const changedText=String(m.text||"")!==oldText;
      const changedButtons=JSON.stringify(m.buttons||[])!==oldButtons;
      if(changedId||changedText||changedButtons)return m;
    }
    await new Promise(r=>setTimeout(r,300));
  }
  return null;
}
async function gameDebug(chat){try{return await renderGame(chat,{force:true});}catch(e){return send(chat,"⚠️ Игровой режим не открылся: "+String(e.message||e).slice(0,700));}}
async function bridgeStatus(chat){const s=userBridge.status();return send(chat,"🔗 Telegram-мост\n\nСтатус: "+(s.connected?"✅ подключён":"❌ не подключён")+"\nИгровой бот: @"+GAME_USERNAME+"\nПользователь: "+(s.username?"@"+s.username:"не определён")+(s.last_error?"\n\n⚠️ "+s.last_error:""));}
async function state(chat){
  try{
    let local=userBridge.status();
    if(!(local && (local.balance!=null||local.garage!=null||local.vehicle?.name||local.raw_message)) && userBridge.configured()){
      try{
        await userBridge.ensureClient();
        local=userBridge.status();
        if(local.connected){
          userBridge.saveBinding(chat);
          await userBridge.sendGameMessage("/start");
          local=userBridge.status();
        }
      }catch(e){ console.log("STATE GAME REFRESH ERROR:",e.message); }
    }
    const s=local && (local.balance!=null||local.garage!=null||local.vehicle?.name||local.raw_message)
      ? local
      : await relay("/state");
    const hasData=s&&(s.balance!=null||s.garage!=null||s.vehicle?.name||s.raw_message);
    if(!hasData)return send(chat,"📊 Текущее состояние\n\n⚠️ Игра ещё не передала состояние. Нажми «🧪 Проверить связь с игрой» или «🧠 Что делать сейчас».");

    const raw=String(s.raw_message||s.last_game_message?.text||"");
    const parsed=raw?parseState(raw):s;
    const strategyState=Object.assign({},parsed,{raw_message:raw,raw_text:parsed.raw_text,buttons:s.buttons||s.last_game_message?.buttons||[]});
    const economy=await economySummary(chat,120);
    const offerMatch=/(?:предлож(?:ение)?\s*(?:покупателя)?|покупатель\s+предлагает|предлагает)[^0-9]{0,30}([0-9][0-9 .]*)\s*(?:₽|руб)/i.exec(raw);
    const offer=offerMatch?Number(offerMatch[1].replace(/[^0-9]/g,"")):null;
    const vehicleEconomics=currentVehicleEconomics(strategyState,offer,0);
    const contract=parseContract(raw);
    const lines=[
      "📊 ТЕКУЩЕЕ СОСТОЯНИЕ","",
      "💰 Баланс: "+(s.balance!=null?Number(s.balance).toLocaleString("ru-RU")+" ₽":"неизвестно"),
      "🚗 Гараж: "+(s.garage??"неизвестно"),
      "🚘 Машина: "+(s.vehicle?.name||"нет данных")
    ];
    if(s.vehicle?.hp!=null)lines.push("⚙️ Мощность: "+s.vehicle.hp+" л.с.");
    if(s.vehicle?.mileage!=null)lines.push("🛣 Пробег: "+Number(s.vehicle.mileage).toLocaleString("ru-RU")+" км");
    if(s.plate)lines.push("🔢 Номер: "+s.plate);
    if(offer!=null)lines.push("💵 Предложение: "+offer.toLocaleString("ru-RU")+" ₽");
    if(vehicleEconomics?.sale){
      const delta=vehicleEconomics.sale.profit;
      lines.push("📈 Результат продажи: "+(delta>=0?"+":"")+Math.round(delta).toLocaleString("ru-RU")+" ₽");
    }
    const activeVehicles=Array.isArray(economy?.vehicles)?economy.vehicles.filter(v=>v.status==="active"):[]; 
    if(activeVehicles.length){
      const v=activeVehicles[0];
      lines.push("🧾 Учтённая себестоимость: "+Math.round(v.full_cost).toLocaleString("ru-RU")+" ₽");
      if(v.realized_profit!=null)lines.push("📚 Учтённый результат: "+(v.realized_profit>=0?"+":"")+Math.round(v.realized_profit).toLocaleString("ru-RU")+" ₽");
    }
    if(contract){
      const cp=[];
      if(contract.reward!=null)cp.push("награда "+Math.round(contract.reward).toLocaleString("ru-RU")+" ₽");
      if(contract.maxPrice!=null)cp.push("лимит "+Math.round(contract.maxPrice).toLocaleString("ru-RU")+" ₽");
      if(contract.minHp!=null)cp.push("от "+contract.minHp+" л.с.");
      lines.push("📋 Контракт: "+(cp.length?cp.join(", "):"условия распознаны"));
    }
    return send(chat,lines.join("\n"));
  }catch(e){return send(chat,"⚠️ Состояние пока недоступно: "+e.message);}
}
async function advice(chat){
  try{
    let current=userBridge.status();
    const localState=current&&(
      current.balance!=null||current.garage!=null||current.vehicle?.name||current.raw_message||current.last_game_message?.text
    ) ? current : null;
    let r=null;
    if(!localState && userBridge.configured()){
      try{
        await userBridge.ensureClient();
        current=userBridge.status();
        if(current.connected){
          userBridge.saveBinding(chat);
          await userBridge.sendGameMessage("/start");
          current=userBridge.status();
          localState=current&&(
            current.balance!=null||current.garage!=null||current.vehicle?.name||current.raw_message||current.last_game_message?.text
          ) ? current : null;
        }
      }catch(e){ console.log("ADVICE GAME REFRESH ERROR:",e.message); }
    }
    if(localState){
      const raw=String(localState.raw_message||localState.last_game_message?.text||"");
      const parsed=raw?parseState(raw):localState;
      const decision=localState.local_decision||decide(parsed,Number(localState.confidence)||70);
      r={text:"🧠 РЕШЕНИЕ: "+(decision.title||decision.action)+"\n\n➡️ Сейчас: "+decision.action+"\n💬 Почему: "+decision.reason+"\n🎯 Уверенность: "+Math.round(Number(decision.confidence)||0)+"%",decision,state:localState,game_buttons:localState.buttons||localState.last_game_message?.buttons||[]};
    }else{
      r=await relay("/telegram/advice",{chat_id:chat});
    }
    const currentMessage=userBridge.status().last_game_message;
    const relayButtons=Array.isArray(r.game_buttons)?r.game_buttons:[];
    const observed=currentMessage?.buttons?.length?currentMessage.buttons:relayButtons;
    const sourceMessageId=currentMessage?.message_id||null;
    const adviceState={...r.state,...(currentMessage||{}),raw_message:currentMessage?.text||r.state?.raw_message};
    const ranked=await rankButtons(chat,adviceState,observed);
    const economy=await economySummary(chat,120);
    const strategy=buildStrategy(adviceState,ranked,economy);
    const recommended=strategy.actionEvidence ? (ranked[0]?.label||null) : null;
    const rows=[];
    if(recommended && sourceMessageId){
      const risk=actionRisk(r.decision?.action||recommended);
      rows.push([{text:(risk?"⚠️ Подтвердить: ":"🤖 Выполнить: ")+recommended,callback_data:confirmButtonData(recommended,sourceMessageId)}]);
    }
    let out=r.text||"Пока нет актуального решения.";
    if(recommended){
      const top=strategy.alternatives.find(x=>x.label===recommended);
      out+="\n\n👉 ЧТО ДЕЛАТЬ СЕЙЧАС: нажать «"+recommended+"»\n📊 Оценка модели: "+ranked[0].percent+"/100\n💬 "+ranked[0].reason;
      if(top) out+="\n⚠️ Риск действия: "+top.risk+"/100"+(top.reasons.length?"\n   └ "+top.reasons.join("; "):"");
    }else if(ranked.length){
      out+="\n\n👉 ЧТО ДЕЛАТЬ СЕЙЧАС: не нажимать наугад\n💬 Текущий экран не подтверждает конкретное действие.";
    }
    if(strategy.contract){
      const p=[];
      if(strategy.contract.reward!=null)p.push("награда "+Math.round(strategy.contract.reward).toLocaleString("ru-RU")+" ₽");
      if(strategy.contract.maxPrice!=null)p.push("лимит "+Math.round(strategy.contract.maxPrice).toLocaleString("ru-RU")+" ₽");
      if(strategy.contract.minHp!=null)p.push("мощность от "+strategy.contract.minHp+" л.с.");
      out+="\n📋 Контракт: "+(p.length?p.join(", "):"условия распознаны");
    }
    if(strategy.warnings.length)out+="\n⚠️ "+strategy.warnings.join("\n⚠️ ");
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
  const chat=q.message?.chat?.id,data=String(q.data||"");
  try{await tg("answerCallbackQuery",{callback_query_id:q.id});}catch{}
  if(data==="game")return renderGame(chat,{messageId:q.message?.message_id});
  if(data==="game_refresh")return renderGame(chat,{messageId:q.message?.message_id});
  if(data==="game_exit"){
    activeGameChats.delete(String(chat));activeGameChats.delete(String(chat)+"_message_id");
    return send(chat,"🚪 Игровой режим закрыт. Нажми «🎮 Играть», чтобы продолжить.");
  }
  if(data.startsWith("confirmbtn:")||data.startsWith("gamebtn:")){
    const prefix=data.startsWith("confirmbtn:")?"confirmbtn":"gamebtn",ref=gameButtonRef(data,prefix);
    const latest=userBridge.status().last_game_message;
    if(!ref||!latest)return send(chat,"⚠️ Экран игры устарел. Нажми «🎮 Играть» ещё раз.");
    let label=null;
    if(ref.legacy)label=(latest.buttons||[]).find(x=>gameButtonKey(x)===ref.key);
    else{try{label=await userBridge.getGameButton(ref.messageId,ref.key);}catch(e){console.log("GAME BUTTON LOOKUP ERROR:",e.message);}}
    if(!label)return send(chat,"⚠️ Эта кнопка больше отсутствует. Нажми «🔄 Обновить игру».");
    const chatKey=String(chat);
    if(gameActionChats.has(chatKey)){
      return send(chat,"⏳ Предыдущее действие ещё выполняется. Дождись нового экрана игры.");
    }
    gameActionChats.add(chatKey);
    let backgroundCallbackWait=false;
    try{
      // Capture the exact pre-click screen before sending the action.
      const beforeState=Object.assign({},userBridge.status());
      const beforeScreen=beforeState.last_game_message;
      await userBridge.clickGameButton(label,ref.messageId);
      recordClick(chat,beforeScreen?.text||"",beforeScreen?.buttons||[],label,userBridge.status().last_game_message?.text||"").catch(e=>console.log("BUTTON STRATEGY CALLBACK ERROR:",e.message));
      if(activeGameChats.get(String(chat))){
        const next=await waitForGameUpdate(ref.messageId,beforeScreen?.text||"",beforeScreen?.buttons||[],1200);
        const screenId=q.message?.message_id||activeGameChats.get(String(chat)+"_message_id");
        if(screenId)activeGameChats.set(String(chat)+"_message_id",screenId);
        if(next){
          const afterState=Object.assign({},userBridge.status());
          recordMemoryAction(chat,beforeState,label,afterState).catch(e=>console.log("GAME MEMORY CALLBACK ERROR:",e.message));
          recordEconomyTransition(chat,beforeState,label,afterState).catch(e=>console.log("GAME ECONOMY CALLBACK ERROR:",e.message));
          await renderGame(chat,{messageId:screenId,force:true});
        }else{
          // Keep the current screen visible while waiting for a slow game response.
          backgroundCallbackWait=true;
          setTimeout(async()=>{
            try{
              const later=await waitForGameUpdate(ref.messageId,beforeScreen?.text||"",beforeScreen?.buttons||[],8000);
              if(later){
                const afterState=Object.assign({},userBridge.status());
                recordMemoryAction(chat,beforeState,label,afterState).catch(e=>console.log("GAME MEMORY LATE CALLBACK ERROR:",e.message));
                recordEconomyTransition(chat,beforeState,label,afterState).catch(e=>console.log("GAME ECONOMY LATE CALLBACK ERROR:",e.message));
                await renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id"),force:true});
              }
            }catch(e){console.log("GAME CALLBACK LATE UPDATE ERROR:",e.message);}
            finally{gameActionChats.delete(String(chat));}
          },0);
        }
        return;
      }
      return send(chat,"✅ Нажал: "+label);
    }catch(e){
      return send(chat,"❌ Не удалось выполнить «"+label+"»: "+String(e.message||e).slice(0,700));
    }finally{
      if(!backgroundCallbackWait)gameActionChats.delete(String(chat));
    }
  }
  if(data==="connect")return connect(chat);
  if(data==="state")return state(chat);
  if(data==="advice")return advice(chat);
  if(data==="probe")return probe(chat);
  if(data==="photo")return send(chat,"📸 Просто отправь сюда скриншот игры.");
  if(data==="menu")return send(chat,"Главное меню:");
}

async function processUpdate(u){
  if(!u || typeof u!=="object") return;
  if(u.update_id!=null) offset=Math.max(offset,Number(u.update_id)+1);
  const chatId=u.callback_query?.message?.chat?.id ?? u.message?.chat?.id ?? "global";
  return enqueueChatUpdate(chatId,async()=>{
    try{
      if(u.callback_query) return await callback(u.callback_query);
      if(u.message) return await handle(u.message);
    }catch(e){
      console.log("UPDATE HANDLER ERROR:",e?.stack||e?.message||e);
      try{
        if(chatId!=="global") await send(chatId,"⚠️ Команда не завершилась корректно. Повторная попытка доступна сразу.");
      }catch(sendError){
        console.log("UPDATE ERROR MESSAGE FAILED:",sendError?.message||sendError);
      }
    }
  });
}
async function setupWebhook(){
  if(!BOT_TOKEN){console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN missing");return false;}
  try{
    // Use a Telegram webhook instead of getUpdates. Long polling causes a hard
    // Telegram conflict whenever Render temporarily has two instances during
    // a rolling deploy/restart. Webhook delivery has no competing pollers.
    if(!BRIDGE_PUBLIC_URL)throw new Error("RENDER_EXTERNAL_URL/BRIDGE_PUBLIC_URL не настроен");
    const webhookUrl=BRIDGE_PUBLIC_URL+"/telegram/webhook";
    const current=await tg("getWebhookInfo",{});
    if(String(current?.url||"")!==webhookUrl){
      await tg("setWebhook",{url:webhookUrl,drop_pending_updates:false,secret_token:WEBHOOK_SECRET,allowed_updates:["message","callback_query"]});
    }
    const info=await tg("getWebhookInfo",{});
    webhookEnabled=true;
    console.log("Telegram delivery mode: webhook; url:",webhookUrl,"pending:",info?.pending_update_count??0);
    return String(info?.url||"")===webhookUrl;
  }catch(e){
    webhookEnabled=false;
    console.log("Telegram delivery setup error:",e.stack||e.message||e);
    return false;
  }
}
async function pollBotUpdates(){
  // Kept as a safety stub. Telegram webhook mode is the only bot-update
  // delivery mechanism, preventing competing getUpdates consumers.
  return;
}
async function loop(){
  if(polling)return;
  polling=true;
  const ready=await setupWebhook();
  if(!ready){polling=false;setTimeout(loop,5000);return;}
  console.log("Telegram webhook active; getUpdates disabled.");
}
userBridge.webhookHandler=processUpdate;
async function gracefulShutdown(signal){
  console.log("RENDER SHUTDOWN:",signal);
  polling=false;
  try { if (userBridge?.httpServer) await new Promise(resolve=>userBridge.httpServer.close(()=>resolve())); } catch(e) { console.log("HTTP SERVER SHUTDOWN ERROR:",e.message); }
  try { if (typeof userBridge.shutdown==="function") await userBridge.shutdown(); } catch(e) { console.log("TELEGRAM BRIDGE SHUTDOWN ERROR:",e.message); }
  process.exit(0);
}
process.once("SIGTERM",()=>gracefulShutdown("SIGTERM"));
process.once("SIGINT",()=>gracefulShutdown("SIGINT"));

console.log("Telegram bridge env:",{apiIdPresent:!!process.env.TELEGRAM_API_ID,apiHashPresent:!!process.env.TELEGRAM_API_HASH});
if(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH)userBridge.ensureClient().then(()=>console.log("Telegram user bridge initialized")).catch(e=>console.log("Telegram user bridge init:",e.message));
registerBotCommands().catch(e=>console.log("Telegram command registration:",e.message));
warmup().then(ok=>console.log("OCR worker warmup:",ok?"ready":"failed")).catch(e=>console.log("OCR warmup error:",e.message));
loop();