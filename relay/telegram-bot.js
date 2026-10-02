const https = require("https");
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:32,maxFreeSockets:8,timeout:60000,freeSocketTimeout:15000});
const { TelegramUserBridge, createConnectServer } = require("./user-session-bridge");
const { analyzeImage, parseState, decide, warmup } = require("./free-analyzer");
const { rankButtons, recordScreen, recordClick } = require("./button-strategy");
const { recordScreen: recordMemoryScreen, recordAction: recordMemoryAction, recent: recentMemory } = require("./game-memory");

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
const activeGameChats=new Map();
const gameActionChats=new Set();
const gameRenderQueues=new Map();
const lastRenderedGameFingerprints=new Map();
const replyKeyboardClearedChats=new Set();
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
  return ranked.map((x,i)=>(i===0?"⭐ ":"")+String(i+1)+". «"+x.label+"» — "+x.percent+"%\n   └ "+x.reason).join("\n");
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
  if(Array.isArray(state.buttons) && state.buttons.length){
    try{await renderGame(chat);}catch(e){console.log("GAME SCREEN PUSH ERROR:",e.message);}
    return;
  }
  const fingerprint=JSON.stringify({balance:state.balance,garage:state.garage,vehicle:state.vehicle,raw_message:state.raw_message});
  if(fingerprint===lastBridgeFingerprint)return;lastBridgeFingerprint=fingerprint;
  if(Date.now()-lastBridgeNotice<5000)return;lastBridgeNotice=Date.now();
  const lines=["🎮 Новое событие из игры","","💰 Баланс: "+(state.balance??"—"),"🚗 Гараж: "+(state.garage??"—")];
  if(state.vehicle?.name)lines.push("🚘 "+state.vehicle.name);
  if(state.vehicle?.price!=null)lines.push("💵 Цена: "+state.vehicle.price);
  const autoDecision=state.local_decision||decide(state,90);
  const ranked=await rankButtons(chat,state,state.buttons||[]);
  if(ranked.length){
    lines.push("","🧠 АВТОАНАЛИЗ КНОПОК","➡️ Лучше нажать: «"+ranked[0].label+"» — "+ranked[0].percent+"%");
    lines.push("📊 ВСЕ КНОПКИ:\n"+buttonScoreText(ranked));
  }else lines.push("","Нажми «🧠 Что делать сейчас», чтобы получить решение ИИ.");
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
  });req.on("error",reject);req.setTimeout(35000,()=>req.destroy(new Error("Telegram API timeout")));req.write(data);req.end();
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
    [{text:"📊 Состояние"},{text:"📸 Анализ скрина"}],
    [{text:"🔗 Подключить игру"}],
    [{text:"🧪 Проверить связь с игрой"}]
  ];
  const connectBase=CONNECT_URL||(BRIDGE_PUBLIC_URL?BRIDGE_PUBLIC_URL+"/connect":"");
  const connectUrl=connectBase&&chatId ? connectBase+(connectBase.includes("?")?"&":"?")+"ticket="+encodeURIComponent(userBridge.createTicket(chatId)) : "";
  if(connectUrl)rows.push([{text:"🎮 Открыть подключение",web_app:{url:connectUrl}}]);
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
      try{
        // Do not require the cached button list to contain the label: the
        // game can update its markup a moment before our local state does.
        const beforeState=Object.assign({},userBridge.status());
        await userBridge.clickGameButton(target,latest.message_id);
        recordClick(chat,latest.text||"",latest.buttons||[],target,userBridge.status().last_game_message?.text||"").catch(e=>console.log("BUTTON STRATEGY CLICK ERROR:",e.message));
        // Do not make the user wait 10 seconds for a slow game response.
        // If the game answers later, the background waiter will refresh the screen.
        const updated=await waitForGameUpdate(latest.message_id,latest.text||"",latest.buttons||[],2500);
        if(updated){
          const afterState=Object.assign({},userBridge.status());
          recordMemoryAction(chat,beforeState,target,afterState).catch(e=>console.log("GAME MEMORY ACTION ERROR:",e.message));
          return renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
        }
        const screenId=activeGameChats.get(String(chat)+"_message_id");
        setTimeout(async()=>{
          try{
            const later=await waitForGameUpdate(latest.message_id,latest.text||"",latest.buttons||[],8000);
            if(later){
              const afterState=Object.assign({},userBridge.status());
              recordMemoryAction(chat,beforeState,target,afterState).catch(e=>console.log("GAME MEMORY DELAYED ACTION ERROR:",e.message));
              await renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
            }
          }catch(e){console.log("GAME LATE UPDATE ERROR:",e.message);}
        },0);
        return renderGame(chat,{messageId:screenId});
      }catch(e){
        // Never fall through to the main-menu fallback while game mode is active.
        return renderGame(chat,{messageId:activeGameChats.get(String(chat)+"_message_id")});
      }finally{
        gameActionChats.delete(String(chat));
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
  const rows=(message?.buttons||[]).map(label=>[{text:String(label)}]);
  rows.push([{text:"⬅️ Назад"}]);
  rows.push([{text:"🔄 Обновить игру"},{text:"🚪 Выйти из игры"}]);
  return {keyboard:rows,resize_keyboard:true,one_time_keyboard:false,is_persistent:true};
}
async function renderGameNow(chat,options={}){
  const s=userBridge.status();
  if(!s.last_game_message && userBridge.configured() && s.connected){
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
  recordScreen(chat,latest.text,latest.buttons||[]).catch(e=>console.log("BUTTON STRATEGY SCREEN ERROR:",e.message));
  recordMemoryScreen(chat,latest).catch(e=>console.log("GAME MEMORY SCREEN ERROR:",e.message));
  const screenConfidence=ranked.length ? 100 : Math.round(Number(decision.confidence)||0);
  const adviceLines=["🎮 ИГРА","",""+String(latest.text||"—").slice(0,7000),"","🧠 КАК ПОСТУПИТЬ: "+(ranked.length?"АНАЛИЗ КНОПОК":"НЕТ КНОПОК"),"🔎 Распознавание кнопок: "+screenConfidence+"%"];
  if(ranked.length){
    adviceLines.push("💡 Проценты — стратегическая оценка по текущему экрану, сохранённой истории твоей игры и финансовому контексту.");
    adviceLines.push("","👉 РЕКОМЕНДАЦИЯ: «"+ranked[0].label+"» — "+ranked[0].percent+"%","📊 ВСЕ КНОПКИ:\n"+buttonScoreText(ranked));
  }else if(decision.reason){
    adviceLines.push("💬 "+decision.reason);
  }
  const text=adviceLines.join("\n");
  const markup=await gameKeyboard(latest);
  const messageId=options.messageId||activeGameChats.get(String(chat)+"_message_id");
  if(messageId){
    try{
      await tg("deleteMessage",{chat_id:chat,message_id:messageId});
    }catch(e){console.log("GAME SCREEN DELETE ERROR:",e.message);}
  }
  let sent=null;
  try {
    const image=await Promise.race([userBridge.getGameMedia(latest.message_id),new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
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
    return send(chat,"📊 Текущее состояние\n\n💰 Баланс: "+(s.balance??"неизвестно")+"\n🚗 Гараж: "+(s.garage??"неизвестно")+"\n🚘 Машина: "+(s.vehicle?.name||"нет данных"));
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
    const recommended=ranked[0]?.label||null;
    const rows=[];
    if(recommended && sourceMessageId){
      const risk=actionRisk(r.decision?.action||recommended);
      rows.push([{text:(risk?"⚠️ Подтвердить: ":"🤖 Выполнить: ")+recommended,callback_data:confirmButtonData(recommended,sourceMessageId)}]);
    }
    let out=r.text||"Пока нет актуального решения.";
    if(recommended) out+="\n\n➡️ Нажать: «"+recommended+"» — "+ranked[0].percent+"%\n💬 "+ranked[0].reason;
    return send(chat,out);
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
    try{
      await userBridge.clickGameButton(label,ref.messageId);
      recordClick(chat,latest.text||"",latest.buttons||[],label,userBridge.status().last_game_message?.text||"").catch(e=>console.log("BUTTON STRATEGY CALLBACK ERROR:",e.message));
      if(activeGameChats.get(String(chat))){
        const beforeScreen=userBridge.status().last_game_message;
        const next=await waitForGameUpdate(ref.messageId,beforeScreen?.text||"",beforeScreen?.buttons||[],10000);
        const screenId=q.message?.message_id||activeGameChats.get(String(chat)+"_message_id");
        if(screenId)activeGameChats.set(String(chat)+"_message_id",screenId);
        if(next){
          const afterState=Object.assign({},userBridge.status());
          recordMemoryAction(chat,beforeState,label,afterState).catch(e=>console.log("GAME MEMORY CALLBACK ERROR:",e.message));
          const markup=await gameKeyboard(next);
          try{
            if(screenId) await tg("deleteMessage",{chat_id:chat,message_id:screenId});
            const sent=await send(chat,"🎮 ИГРА\n\n"+String(next.text||"—").slice(0,10000),{reply_markup:markup});
            if(sent?.message_id) activeGameChats.set(String(chat)+"_message_id",sent.message_id);
          }catch(e){console.log("GAME SCREEN AFTER CLICK ERROR:",e.message);}
        }else await renderGame(chat,{messageId:screenId});
        return;
      }
      return send(chat,"✅ Нажал: "+label);    }catch(e){return send(chat,"❌ Не удалось выполнить «"+label+"»: "+String(e.message||e).slice(0,700));}
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
  if(polling)return;
  polling=true;
  while(true){
    const ok=await setupWebhook();
    if(ok){
      console.log("Telegram webhook active; polling disabled.");
      return;
    }
    console.log("Telegram webhook unavailable; retrying in 5000ms. Polling is disabled to avoid webhook/getUpdates conflicts.");
    await new Promise(r=>setTimeout(r,5000));
  }
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