const http = require("http");
const https = require("https");
const { acquireTelegramPollLock, releaseTelegramPollLock } = require("./telegram-poll-lock");
const autonomousGame = require("./autonomous-game");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = "https://api.telegram.org/bot" + BOT_TOKEN;
const HEALTH_PORT = Number(process.env.PORT || 10000);
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:32,maxFreeSockets:8,timeout:60000,freeSocketTimeout:15000});
let offset=0,polling=false;
const updateQueues=new Map();
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
  const guarded=withTimeout(Promise.resolve().then(task),22000,"TELEGRAM UPDATE");
  const current=previous.catch(()=>{}).then(()=>guarded);
  updateQueues.set(key,current);
  return current.finally(()=>{if(updateQueues.get(key)===current)updateQueues.delete(key);});
}
process.on("unhandledRejection",e=>console.log("UNHANDLED REJECTION:",e?.stack||e?.message||e));
process.on("uncaughtException",e=>console.log("UNCAUGHT EXCEPTION:",e?.stack||e?.message||e));

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
async function send(chat,text,extra={}){
  return tg("sendMessage",Object.assign({chat_id:chat,text:String(text||""),disable_web_page_preview:true},extra));
}
async function registerBotCommands(){
  const commands=[
    {command:"start",description:"Открыть игру"},
    {command:"game",description:"Симулятор Перекупа"},
    {command:"perekup",description:"Симулятор Перекупа"}
  ];
  for(let attempt=1;attempt<=5;attempt++){
    try{
      await tg("setMyCommands",{commands,scope:{type:"all_private_chats"}});
      console.log("Telegram commands registered: autonomous game only");
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
  if(text==="/start"||text==="/game"||text==="/perekup"){
    try{await tg("sendMessage",{chat_id:chat,text:" ",reply_markup:{remove_keyboard:true}});}catch{}
    return autonomousGame.handleText(chat,"/perekup",m.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra));
  }
  return false;
}
async function handleCallback(q){
  const chat=q?.message?.chat?.id,data=String(q?.data||"");if(chat==null)return;
  if(!data.startsWith("ag:")){try{await tg("answerCallbackQuery",{callback_query_id:q.id});}catch{}return;}
  return autonomousGame.handleCallback(chat,data,q.from?.first_name||"Перекуп",(c,t,extra)=>send(c,t,extra),()=>tg("answerCallbackQuery",{callback_query_id:q.id}),q.id);
}
async function processUpdate(update){
  if(!update||typeof update!=="object")return;
  if(update.update_id!=null)offset=Math.max(offset,Number(update.update_id)+1);
  const chat=update.callback_query?.message?.chat?.id??update.message?.chat?.id??"global";
  return enqueueChatUpdate(chat,async()=>{
    try{
      if(update.callback_query)return await handleCallback(update.callback_query);
      if(update.message)return await handleMessage(update.message);
    }catch(e){
      console.log("UPDATE HANDLER ERROR:",e?.stack||e?.message||e);
      if(chat!=="global"){try{await send(chat,"⚠️ Ошибка обработки. Попробуй ещё раз.");}catch(sendError){console.log("ERROR MESSAGE FAILED:",sendError?.message||sendError);}}
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
  if(!BOT_TOKEN)return;
  const lock=await acquireTelegramPollLock();
  if(!lock){console.log("Telegram delivery passive; another instance owns polling.");return;}
  try{
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
}
async function loop(){
  if(polling)return;
  polling=true;
  const ready=await setupTelegramDelivery();
  if(!ready){polling=false;setTimeout(loop,5000);return;}
  console.log("Telegram delivery active; autonomous game polling started.");
  pollBotUpdates().then(()=>{if(polling)setTimeout(loop,3000);}).catch(e=>{console.log("TELEGRAM POLLING FATAL:",e?.stack||e?.message||e);polling=false;setTimeout(loop,3000);});
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
registerBotCommands().catch(e=>console.log("Telegram command registration:",e.message));
loop();
