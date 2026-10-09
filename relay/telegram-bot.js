const http = require("http");
const { Pool } = require("pg");
const https = require("https");
const { acquireTelegramPollLock, releaseTelegramPollLock } = require("./telegram-poll-lock");
const autonomousGame = require("./autonomous-game");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = "https://api.telegram.org/bot" + BOT_TOKEN;
const HEALTH_PORT = Number(process.env.PORT || 10000);
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:32,maxFreeSockets:8,timeout:60000,freeSocketTimeout:15000});
let offset=0,polling=false;
let pollStatePoolPromise=null;
const updateQueues=new Map();
const failedUpdateAttempts=new Map();
const MAX_UPDATE_RETRIES=5;
const BOT_REQUEST_TIMEOUT=10000;

const healthServer = http.createServer((req,res)=>{
  if(req.url === "/" || req.url === "/health"){
    res.writeHead(200,{"content-type":"text/plain; charset=utf-8"});
    return res.end("CarFlipCopilot autonomous game: OK\n");
  }
  res.writeHead(404,{"content-type":"text/plain; charset=utf-8"});
  res.end("Not found\n");
});
healthServer.listen(HEALTH_PORT,"0.0.0.0",()=>console.log("Health server listening on port "+HEALTH_PORT));

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
  const current=previous.catch(()=>{}).then(()=>Promise.resolve().then(task));
  updateQueues.set(key,current);
  return current.finally(()=>{if(updateQueues.get(key)===current)updateQueues.delete(key);});
}
process.on("unhandledRejection",e=>console.log("UNHANDLED REJECTION:",e?.stack||e?.message||e));
process.on("uncaughtException",e=>console.log("UNCAUGHT EXCEPTION:",e?.stack||e?.message||e));

function pollStateDb(){
  if(!process.env.DATABASE_URL)return null;
  if(!pollStatePoolPromise){
    pollStatePoolPromise=Promise.resolve(new Pool({
      connectionString:process.env.DATABASE_URL,
      ssl:{rejectUnauthorized:false},
      max:2,
      connectionTimeoutMillis:5000,
      query_timeout:7000,
      statement_timeout:7000
    }));
  }
  return pollStatePoolPromise;
}
async function loadTelegramOffset(){
  const p=pollStateDb();
  if(!p){offset=0;return 0;}
  const pool=await p;
  await pool.query(`CREATE TABLE IF NOT EXISTS telegram_poll_state (id integer PRIMARY KEY, poll_offset bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO telegram_poll_state(id,poll_offset) VALUES(1,0) ON CONFLICT(id) DO NOTHING`);
  const r=await pool.query(`SELECT poll_offset FROM telegram_poll_state WHERE id=1`);
  offset=Number(r.rows[0]?.poll_offset||0);
  console.log("Telegram poll offset loaded:",offset);
  return offset;
}
async function saveTelegramOffset(nextOffset){
  const p=pollStateDb();
  if(!p)return;
  const pool=await p;
  await pool.query(`UPDATE telegram_poll_state SET poll_offset=$1,updated_at=now() WHERE id=1`,[String(nextOffset)]);
}

function tg(method,body){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body||{}),u=new URL(API+"/"+method);
    const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},res=>{
      let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{const j=JSON.parse(s);if(!j.ok)return reject(new Error(j.description||"Telegram API error"));resolve(j.result);}catch(e){reject(e);}});
    });
    req.on("error",reject);req.setTimeout(BOT_REQUEST_TIMEOUT,()=>req.destroy(new Error("Telegram API timeout")));req.write(data);req.end();
  });
}
function tgLongPoll(body){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body||{}),u=new URL(API+"/getUpdates");
    const req=https.request({hostname:u.hostname,path:u.pathname,method:"POST",agent:keepAliveAgent,headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},res=>{
      let s="";res.on("data",c=>s+=c);res.on("end",()=>{try{const j=JSON.parse(s);if(!j.ok)return reject(new Error(j.description||"Telegram getUpdates error"));resolve(Array.isArray(j.result)?j.result:[]);}catch(e){reject(e);}});
    });
    req.on("error",reject);req.setTimeout(30000,()=>req.destroy(new Error("Telegram getUpdates timeout")));req.write(data);req.end();
  });
}
function downloadPhoto(url,redirects=0){
  return new Promise((resolve,reject)=>{
    if(redirects>4)return reject(new Error("Photo URL redirect limit exceeded"));
    let parsed;
    try{parsed=new URL(url);}catch(e){return reject(new Error("Invalid photo URL"));}
    if(parsed.protocol!=="https:")return reject(new Error("Photo URL must use HTTPS"));
    const req=https.get(parsed,{agent:keepAliveAgent,headers:{"user-agent":"AUTOFLIP Telegram Bot/1.0","accept":"image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
        res.resume();
        const next=new URL(res.headers.location,parsed).toString();
        return resolve(downloadPhoto(next,redirects+1));
      }
      if(res.statusCode!==200){res.resume();return reject(new Error("Photo download HTTP "+res.statusCode));}
      const type=String(res.headers["content-type"]||"").toLowerCase();
      if(!type.startsWith("image/")){res.resume();return reject(new Error("Photo URL returned non-image content: "+type));}
      const chunks=[];let size=0;const max=9*1024*1024;
      res.on("data",chunk=>{size+=chunk.length;if(size>max){req.destroy(new Error("Photo exceeds 9 MB limit"));return;}chunks.push(chunk);});
      res.on("end",()=>{if(size)resolve({buffer:Buffer.concat(chunks,size),contentType:type});else reject(new Error("Downloaded photo is empty"));});
      res.on("error",reject);
    });
    req.setTimeout(12000,()=>req.destroy(new Error("Photo download timeout")));
    req.on("error",reject);
  });
}
function tgSendPhotoUpload(chat,caption,photoUrl,replyMarkup){
  return downloadPhoto(String(photoUrl)).then(({buffer,contentType})=>new Promise((resolve,reject)=>{
    const boundary="----AUTOFLIP"+Math.random().toString(16).slice(2);
    const fields={chat_id:String(chat),caption:String(caption||"").slice(0,1024)};
    if(replyMarkup)fields.reply_markup=JSON.stringify(replyMarkup);
    const chunks=[];
    for(const [name,value] of Object.entries(fields)){
      chunks.push(Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+name+"\"\r\n\r\n"+value+"\r\n"));
    }
    const extension=contentType.includes("png")?"png":contentType.includes("webp")?"webp":"jpg";
    chunks.push(Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"autoflip-car."+extension+"\"\r\nContent-Type: "+contentType+"\r\n\r\n"));
    chunks.push(buffer);
    chunks.push(Buffer.from("\r\n--"+boundary+"--\r\n"));
    const body=Buffer.concat(chunks);
    const req=https.request({hostname:"api.telegram.org",path:"/bot"+BOT_TOKEN+"/sendPhoto",method:"POST",agent:keepAliveAgent,headers:{"content-type":"multipart/form-data; boundary="+boundary,"content-length":body.length}},res=>{
      let data="";res.on("data",chunk=>data+=chunk);res.on("end",()=>{try{const json=JSON.parse(data);if(!json.ok)return reject(new Error(json.description||"Telegram sendPhoto failed"));resolve(json.result);}catch(e){reject(e);}});
    });
    req.on("error",reject);req.setTimeout(BOT_REQUEST_TIMEOUT,()=>req.destroy(new Error("Telegram photo upload timeout")));req.end(body);
  }));
}
async function send(chat,text,extra={}){
  if(extra?.photo_url){
    try{
      return await tgSendPhotoUpload(chat,text,extra.photo_url,extra.reply_markup);
    }catch(e){
      console.log("CAR PHOTO UPLOAD ERROR:",e?.message||e);
      return tg("sendMessage",{
        chat_id:chat,
        text:String(text||"")+"\n\n📷 Фото этой модели временно недоступно.",
        disable_web_page_preview:true,
        ...(extra.reply_markup?{reply_markup:extra.reply_markup}:{})
      });
    }
  }
  return tg("sendMessage",Object.assign({chat_id:chat,text:String(text||""),disable_web_page_preview:true},extra));
}
async function registerBotCommands(){
  const commands=[
    {command:"start",description:"Начать игру AUTOFLIP"},
    {command:"game",description:"Открыть AUTOFLIP"},
    {command:"perekup",description:"Открыть игру"},
    {command:"help",description:"Помощь и правила"}
  ];
  for(let attempt=1;attempt<=5;attempt++){
    try{
      await tg("setMyName",{name:"AUTOFLIP"});
      await tg("setMyShortDescription",{short_description:"Премиальный симулятор автомобильного флипа"});
      await tg("setMyDescription",{description:"AUTOFLIP — автономный симулятор автомобильного бизнеса. Покупай автомобили, торгуйся, ремонтируй, управляй гаражом, работай с номерами и развивай свой капитал. Играть можно сразу, без подключения и без участия администратора."});
      await tg("setMyCommands",{commands,scope:{type:"all_private_chats"}});
      console.log("Telegram profile and commands registered: AUTOFLIP");
      return true;
    }catch(e){
      console.log("COMMANDS REGISTER ERROR attempt="+attempt+":",e.message);
      if(attempt<5)await new Promise(r=>setTimeout(r,attempt*1000));
    }
  }
  return false;
}
async function handleMessage(m){
  const chat=m?.chat?.id;if(chat==null)return;
  const text=String(m.text||"").trim();
  const command=text.split(/\s/,1)[0].split("@")[0].toLowerCase();
  const controlActions={"🚗 Рынок":"market","🏠 Гараж":"garage","📅 Сегодня":"day","📋 Контракты":"contracts","🔢 Номера":"plates","📊 Статистика":"stats","🏠 Главное меню":"home","⬅️ В меню":"home"};
  if(controlActions[text]) return autonomousGame.handleCallback(chat,"ag:"+controlActions[text],m.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra));
  if(command==="/help") return send(chat,"🧭 AUTOFLIP — ПОМОЩЬ\n\n/start — начать\n/game — открыть игру\n/perekup — открыть игру\n/help — эта помощь\n\nИспользуй кнопки внутри игры.",{reply_markup:{inline_keyboard:[[{text:"🎮 Открыть AUTOFLIP",callback_data:"ag:home"}]]}});
  if(command==="/start"||command==="/game"||command==="/perekup"){
    await tg("sendMessage",{chat_id:chat,text:"🎮 КНОПКИ УПРАВЛЕНИЯ AUTOFLIP\nВыбирай раздел кнопками внизу. Вводить команды вручную не нужно.",reply_markup:{keyboard:[[{text:"🚗 Рынок"},{text:"🏠 Гараж"}],[{text:"📅 Сегодня"},{text:"📋 Контракты"}],[{text:"🔢 Номера"},{text:"📊 Статистика"}],[{text:"🏠 Главное меню"}]],resize_keyboard:true,is_persistent:true}});
    return autonomousGame.handleText(chat,"/perekup",m.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra));
  }
  return autonomousGame.handleText(chat,text,m.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra));
}
async function handleCallback(q){
  const chat=q?.message?.chat?.id,data=String(q?.data||"");if(chat==null)return;
  if(!data.startsWith("ag:")){try{await tg("answerCallbackQuery",{callback_query_id:q.id});}catch{}return;}
  return autonomousGame.handleCallback(chat,data,q.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra),()=>tg("answerCallbackQuery",{callback_query_id:q.id}),q.id);
}
async function processUpdate(update){
  if(!update||typeof update!=="object")return false;
  const chat=update.callback_query?.message?.chat?.id??update.message?.chat?.id??"global";
  return enqueueChatUpdate(chat,async()=>{
    try{
      if(update.callback_query)await handleCallback(update.callback_query);
      else if(update.message)await handleMessage(update.message);
      if(update.update_id!=null){
        const next=Math.max(offset,Number(update.update_id)+1);
        offset=next;
        await saveTelegramOffset(next);
      }
      return true;
    }catch(e){
      console.log("UPDATE HANDLER ERROR:",e?.stack||e?.message||e);
      if(chat!=="global"){
        try{await send(chat,"⚠️ Ошибка обработки. Повторяю попытку автоматически.");}
        catch(sendError){console.log("ERROR MESSAGE FAILED:",sendError?.message||sendError);}
      }
      if(update.update_id!=null){
        const key=String(update.update_id);
        const attempts=(failedUpdateAttempts.get(key)||0)+1;
        failedUpdateAttempts.set(key,attempts);
        if(attempts>=MAX_UPDATE_RETRIES){
          const next=Math.max(offset,Number(update.update_id)+1);
          offset=next;
          failedUpdateAttempts.delete(key);
          await saveTelegramOffset(next);
          console.log("UPDATE SKIPPED AFTER RETRIES:",update.update_id);
        }else{
          console.log("UPDATE WILL RETRY:",update.update_id,"attempt",attempts+"/"+MAX_UPDATE_RETRIES);
        }
      }
    }
  });
}
async function setupTelegramDelivery(){
  if(!BOT_TOKEN){console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN missing");return false;}
  try{
    try{await tg("deleteWebhook",{drop_pending_updates:false});}catch(e){console.log("Telegram webhook cleanup warning:",e.message);}
    const info=await tg("getWebhookInfo",{});
    console.log("Telegram delivery mode: polling; webhook:",String(info?.url||"none"),"pending:",info?.pending_update_count??0);
    return true;
  }catch(e){console.log("Telegram delivery setup error:",e.stack||e.message||e);return false;}
}
async function pollBotUpdates(){
  if(!BOT_TOKEN)return false;
  const lock=await acquireTelegramPollLock();
  if(!lock){
    console.log("Telegram delivery passive; another instance owns polling. Will retry.");
    return false;
  }
  try{
    const ready=await setupTelegramDelivery();
    if(!ready){
      console.log("Telegram delivery setup failed; releasing poll lock.");
      return false;
    }
    await registerBotCommands();
    await loadTelegramOffset();
    while(polling){
      try{
        const updates=await tgLongPoll({offset,timeout:20,limit:100,allowed_updates:["message","callback_query"]});
        for(const update of updates){try{await processUpdate(update);}catch(e){console.log("POLL UPDATE ERROR:",e?.stack||e?.message||e);}}
      }catch(e){
        if(!polling)break;
        const msg=String(e.message||e);console.log("TELEGRAM POLLING ERROR:",msg);
        if(/Conflict: terminated by other getUpdates request/i.test(msg)){await new Promise(r=>setTimeout(r,5000));continue;}
        await new Promise(r=>setTimeout(r,1500));
      }
    }
  }finally{await releaseTelegramPollLock();}
  return true;
}
async function loop(){
  if(!BOT_TOKEN||polling)return;
  polling=true;
  console.log("Telegram delivery starting; waiting for poll lock.");
  try{
    const started=await pollBotUpdates();
    if(!started) console.log("Telegram delivery is passive; no polling lock owned.");

  }catch(e){
    console.log("TELEGRAM POLLING FATAL:",e?.stack||e?.message||e);
  }finally{
    polling=false;
    setTimeout(loop,3000);
  }
}
async function gracefulShutdown(signal){
  console.log("RENDER SHUTDOWN:",signal);polling=false;
  try{healthServer.close();}catch(e){}
  try{await releaseTelegramPollLock();}catch(e){}
  process.exit(0);
}
process.once("SIGTERM",()=>gracefulShutdown("SIGTERM"));
process.once("SIGINT",()=>gracefulShutdown("SIGINT"));
console.log("CarFlipCopilot mode: AUTONOMOUS GAME ONLY");
autonomousGame.init().then(ok=>console.log("Autonomous game DB:",ok?"ready":"DATABASE_URL missing")).catch(e=>console.log("Autonomous game DB init:",e.message));
loop();
