const http=require("http");
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");

const clients=new Set();
const token=process.env.COPILOT_TOKEN||"";

const model="free-local-ocr";
const BUILD_ID="whole-game-planner-2026-10-02-bridge-advice-2";
const uploadDir=process.env.UPLOAD_DIR||path.join(process.cwd(),"uploads");
fs.mkdirSync(uploadDir,{recursive:true});
let latest=null;
const uploads=new Map();
let latestFrame=null;
let aiBusy=false;
let pendingFrame=null;
let lastAiError="";
let lastAiStatus="";
let lastFrameAt=0;
let lastAiAt=0;
const aiHistory=[];
process.on("uncaughtException",e=>log("PROCESS uncaughtException",e&&e.stack||e));
process.on("unhandledRejection",e=>log("PROCESS unhandledRejection",e&&e.stack||e));

const liveDecisionSchema={
 type:"object",
 properties:{
  action:{type:"string"},
  title:{type:"string"},
  reason:{type:"string"},
  confidence:{type:"number"},
  game_state:{type:"string"},
  sale_price:{anyOf:[{type:"number"},{type:"null"}]},
  expected_profit:{anyOf:[{type:"number"},{type:"null"}]},
  roi_percent:{anyOf:[{type:"number"},{type:"null"}]},
  next_actions:{type:"array",items:{type:"string"}},
  changes:{type:"array",items:{type:"string"}}
 },
 required:["action","title","reason","confidence","game_state","sale_price","expected_profit","roi_percent","next_actions","changes"],
 additionalProperties:false
};

function auth(req){return token.length>0 && req.headers.authorization==="Bearer "+token}
function log(){console.log(new Date().toISOString(),...arguments)}
function setAiStatus(message){lastAiStatus=String(message||"");broadcast({type:"ai_status",message:lastAiStatus});}

function safeName(s){return String(s||"attachment").replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120)}
function json(res,status,obj){res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(obj))}
function broadcast(obj,except){
 let data;
 try { data=frame(obj); } catch(e) { log("WS FRAME ERROR",e.message); return; }
 for(const c of [...clients]){
  if(c===except || c.destroyed || c.writableEnded){ clients.delete(c); continue; }
  try {
   c.write(data);
  } catch(e) {
   clients.delete(c);
   try { c.destroy(); } catch {}
   log("WS WRITE ERROR",e.message);
  }
 }
}
function frame(obj){
 const p=Buffer.from(JSON.stringify(obj));
 if(p.length<126)return Buffer.concat([Buffer.from([129,p.length]),p]);
 if(p.length<65536){const h=Buffer.alloc(4);h[0]=129;h[1]=126;h.writeUInt16BE(p.length,2);return Buffer.concat([h,p])}
 throw new Error("websocket message too large");
}

const {spawnSync}=require("child_process");
const { analyzeImage, parseState, decide } = require("./free-analyzer");

const analysisSchema={
 type:"object",strict:true,
 properties:{
  attachment_type:{type:"string",enum:["image","video","document","file"]},
  detected_game_state:{type:"string"},
  vehicle:{type:["object","null"],properties:{
   name:{type:["string","null"]},plate:{type:["string","null"]},price:{type:["number","null"]},
   hp:{type:["number","null"]},mileage:{type:["number","null"]},owners:{type:["number","null"]},
   origin:{type:["string","null"]},painted_parts:{type:["number","null"]}
  },required:["name","plate","price","hp","mileage","owners","origin","painted_parts"],additionalProperties:false},
  buyer_offers:{type:"array",items:{type:"object",properties:{
   amount:{type:"number"},condition:{type:"string"},buyer:{type:["string","null"]},notes:{type:"string"}
  },required:["amount","condition","buyer","notes"],additionalProperties:false}},
  actions:{type:"array",items:{type:"object",properties:{
   action:{type:"string"},cost:{type:["number","null"]},expected_value_change:{type:["number","null"]},
   roi_percent:{type:["number","null"]},reason:{type:"string"}
  },required:["action","cost","expected_value_change","roi_percent","reason"],additionalProperties:false}},
  sale_price:{type:["number","null"]},
  expected_profit:{type:["number","null"]},
  roi_percent:{type:["number","null"]},
  confidence:{type:"number"},
  changes:{type:"array",items:{type:"string"}},
  next_actions:{type:"array",items:{type:"string"}}
 },required:["attachment_type","detected_game_state","vehicle","buyer_offers","actions","sale_price","expected_profit","roi_percent","confidence","changes","next_actions"],additionalProperties:false
};

function extractVideoFrames(file){
 const dir=path.join(uploadDir,"frames_"+crypto.randomUUID());
 fs.mkdirSync(dir,{recursive:true});
 const r=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-i",file,"-vf","fps=1/4,scale=960:-2","-frames:v","12",path.join(dir,"frame_%02d.jpg")],{timeout:45000});
 if(r.error||r.status!==0){try{fs.rmSync(dir,{recursive:true,force:true})}catch{};return []}
 const frames=fs.readdirSync(dir).sort().map(x=>path.join(dir,x));
 return frames;
}
async function analyzeLiveFrame(){
 if(aiBusy||!latestFrame)return;
 aiBusy=true;
 const frame=latestFrame; latestFrame=null;
 lastAiAt=Date.now(); lastAiError="";
 setAiStatus("Локальный OCR анализирует экран игры…");
 try{
  const r=await analyzeImage(Buffer.from(frame,"base64"));
  const d=r.decision||{};
  const decision={
   action:d.action||"УТОЧНИ СИТУАЦИЮ",
   title:d.title||"Локальный анализ",
   reason:d.reason||"",
   confidence:Number(d.confidence)||0,
   game_state:r.raw_text||"",
   sale_price:r.vehicle?.price??null,
   expected_profit:null,
   roi_percent:null,
   next_actions:[],
   changes:[]
  };
  latest={...(latest||{}),balance:r.balance??latest?.balance,garage:r.garage??latest?.garage,vehicle:r.vehicle??latest?.vehicle,ocr:r.raw_text};
  aiHistory.push({time:Date.now(),decision,state:{balance:latest.balance,garage:latest.garage,vehicle:latest.vehicle,ocr:latest.ocr}});
  if(aiHistory.length>30)aiHistory.shift();
  broadcast({type:"state",...latest});
  broadcast({type:"ai_decision",decision,time:Date.now()});
  setAiStatus("Готово • бесплатный локальный анализ");
 }catch(e){
  lastAiError=String(e.message||e); setAiStatus("Ошибка локального OCR: "+lastAiError.slice(0,240));
 }finally{
  aiBusy=false;
  if(latestFrame)analyzeLiveFrame();
 }
}

function basePrompt(u){
 return "Ты — CarFlipCopilot, игровой аналитик. Анализируй текущую игру про перекуп автомобилей целиком, а не только машину. "+
 "Извлекай только данные, которые реально видны/прочитаны. Запоминай предложения покупателей по состоянию машины. "+
 "Для каждого действия (чип, турбина, полировка, окраска, ремонт, диагностика и т.п.) оцени ROI только если есть данные для расчёта; иначе null. "+
 "Считай ожидаемую прибыль как sale_price минус покупка и известные расходы, не выдумывай покупку/расходы. "+
 "Учитывай текущий баланс, гараж, сделки, торг, аукцион номеров, контракты и другие игровые события. "+
 "Верни строго JSON по заданной схеме. Текущее состояние: "+JSON.stringify(latest||{})+
 "\nВложение: "+u.name+" ("+u.mime+").";
}
async function analyzeAttachment(u){
 let frameFiles=[];
 try{
  if((u.mime||"").startsWith("image/")){
   const r=await analyzeImage(fs.readFileSync(u.file));
   u.analysis={attachment_type:"image",detected_game_state:r.raw_text,vehicle:r.vehicle,buyer_offers:[],actions:[r.decision],sale_price:r.vehicle?.price??null,expected_profit:null,roi_percent:null,confidence:r.decision?.confidence||0,changes:[],next_actions:[r.decision?.action||""]};
  }else if((u.mime||"").startsWith("video/")){
   frameFiles=extractVideoFrames(u.file);
   const results=[];
   for(const f of frameFiles.slice(0,6)) results.push(await analyzeImage(fs.readFileSync(f)));
   const last=results[results.length-1]||{};
   u.analysis={attachment_type:"video",detected_game_state:results.map(x=>x.raw_text).join("\n---\n"),vehicle:last.vehicle||null,buyer_offers:[],actions:results.map(x=>x.decision),sale_price:last.vehicle?.price??null,expected_profit:null,roi_percent:null,confidence:last.decision?.confidence||0,changes:[],next_actions:results.map(x=>x.decision?.action).filter(Boolean)};
  }else{
   u.analysis={attachment_type:"file",detected_game_state:"Файл не является изображением.",vehicle:null,buyer_offers:[],actions:[],sale_price:null,expected_profit:null,roi_percent:null,confidence:0,changes:[],next_actions:["Пришли скриншот PNG/JPG"]};
  }
  u.analyzedAt=Date.now();
  broadcast({type:"attachment_analysis",id:u.id,name:u.name,mime:u.mime,analysis:u.analysis,time:u.analyzedAt});
 }catch(e){
  u.analysisError=String(e.message||e);broadcast({type:"attachment_analysis_error",id:u.id,error:u.analysisError});
 }finally{
  for(const f of frameFiles)try{fs.unlinkSync(f)}catch{}
  if(frameFiles.length)try{fs.rmSync(path.dirname(frameFiles[0]),{recursive:true,force:true})}catch{}
 }
}

const server=http.createServer((req,res)=>{
 if(req.url==="/health")return json(res,200,{ok:true,build:BUILD_ID,model,clients:clients.size,uploads:uploads.size,ai:true,lastFrameAt,lastAiAt,lastAiStatus,lastAiError:lastAiError?lastAiError.slice(0,500):""});
 if(!auth(req))return json(res,401,{error:"unauthorized"});
 if(req.url==="/state")return json(res,200,latest||{});
 if(req.url==="/attachments")return json(res,200,[...uploads.values()].map(({file,...x})=>x));
 if(req.url==="/bridge/state" && req.method==="POST"){
  if(!auth(req)) return json(res,401,{error:"unauthorized"});
  let body="";req.on("data",x=>body+=x);req.on("end",()=>{try{latest=JSON.parse(body||"{}");latest.source=latest.source||"telegram_user_session";broadcast({type:"state",...latest});return json(res,200,{ok:true})}catch(e){return json(res,400,{error:e.message})}});return;
 }
 if(req.url==="/telegram/advice" && req.method==="POST"){
  // The Telegram game bridge publishes state directly. Do not require a prior
  // screenshot/OCR run before /advice can produce a decision.
  let bridgeDecision=(latest&&latest.local_decision)||null;
  if(!bridgeDecision && latest){
   try{
    const sourceText=String(latest.raw_message||latest.ocr||"");
    if(sourceText.trim()){
      const parsed=parseState(sourceText);
      bridgeDecision=decide(parsed, Number(latest.confidence)||70);
    }
   }catch(e){ log("BRIDGE ADVICE PARSE ERROR",e.message); }
  }
  // Prefer the decision bound to the newest Telegram game state.
  // aiHistory may contain an older screenshot decision and must never override fresh bridge data.
  const last=bridgeDecision || (aiHistory.length ? aiHistory[aiHistory.length-1].decision : null);
  const local=(latest&&latest.memory&&(latest.memory.local_plan||latest.local_plan))||latest?.local_plan||null;
  if(last){
   const d=last;
   const lines=[
    "🧠 РЕШЕНИЕ: "+String(d.title||d.action||"Анализ"),
    "",
    "➡️ Сейчас: "+String(d.action||"уточнить ситуацию"),
    "💬 Почему: "+String(d.reason||"нет объяснения"),
    "🎯 Уверенность: "+Math.round(Number(d.confidence)||0)+"%",
    d.expected_profit!=null ? "💰 Ожидаемая прибыль: "+d.expected_profit : "",
    d.roi_percent!=null ? "📈 ROI: "+d.roi_percent+"%" : "",
    d.next_actions?.length ? "\nСледом:\n• "+d.next_actions.join("\n• ") : ""
   ].filter(Boolean);
   return json(res,200,{ok:true,text:lines.join("\n"),decision:d,game_buttons:(latest&&latest.buttons)||[]});
  }
  if(local){
   return json(res,200,{ok:true,text:"🧠 Пока нет свежего AI-решения. Локальный план:\n\n"+JSON.stringify(local),local_plan:local,game_buttons:(latest&&latest.buttons)||[]});
  }
  return json(res,200,{ok:false,text:"Пока нет актуального анализа игры. Сначала передай состояние экрана/игры в CarFlipCopilot."});
 }

 const m=req.url.match(/^\/attachments\/([^/]+)$/);
 if(m&&req.method==="GET"){
  const u=uploads.get(m[1]);if(!u)return json(res,404,{error:"not_found"});
  if(!u.file||!fs.existsSync(u.file))return json(res,404,{error:"file_not_available"});
  res.writeHead(200,{"content-type":u.mime||"application/octet-stream","content-disposition":"attachment; filename=\""+safeName(u.name)+"\""});
  return fs.createReadStream(u.file).pipe(res);
 }
 res.writeHead(404);res.end("not found");
});

server.on("upgrade",(req,socket)=>{
 if(req.url!=="/ws"||!auth(req)){log("WS REJECT",req.url,"auth="+auth(req));socket.destroy();return}
 const key=req.headers["sec-websocket-key"];
 const accept=crypto.createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
 socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n");
 socket._buf=Buffer.alloc(0);clients.add(socket);
 log("WS CONNECT build="+BUILD_ID+" clients="+clients.size);
 broadcast({type:"ai_status",message:"Relay build "+BUILD_ID+" подключён"});
 socket.on("error",e=>log("WS SOCKET ERROR",e&&e.stack||e));
 socket.on("data",buf=>{
  socket._buf=Buffer.concat([socket._buf,buf]);
  while(socket._buf.length>=2){
   const b1=socket._buf[0],b2=socket._buf[1],masked=!!(b2&128);let len=b2&127,off=2;
   if(len===126){if(socket._buf.length<4)return;len=socket._buf.readUInt16BE(2);off=4}
   else if(len===127){if(socket._buf.length<10)return;len=Number(socket._buf.readBigUInt64BE(2));off=10}
   if(masked)off+=4;if(socket._buf.length<off+len)return;
   const payload=Buffer.from(socket._buf.subarray(off,off+len));
   if(masked){const m=socket._buf.subarray(off-4,off);for(let i=0;i<payload.length;i++)payload[i]^=m[i%4]}
   socket._buf=socket._buf.subarray(off+len);
   if((b1&15)===8){clients.delete(socket);socket.end();return}
   if((b1&15)===9){socket.write(Buffer.from([138,0]));continue}
   if((b1&15)===10)continue;
   if((b1&15)!==1)continue;
   try{
    const msg=JSON.parse(payload.toString());
    if(msg.type==="state"){
      latest=msg;
      latest.received_at=Date.now();
      log("STATE balance="+msg.balance+" garage="+msg.garage+" ocr="+String(msg.ocr||"").length);
      // Состояние из Telegram user-session уже является серверным источником истины.
      // Android/ML Kit здесь больше не используется: бот полностью работает без APK.
    }
    if(msg.type==="frame"){latestFrame=msg.jpegBase64||null;lastFrameAt=Date.now();log("FRAME received bytes="+Buffer.byteLength(latestFrame||"","base64"));setAiStatus("Кадр получен relay • запускаю анализ");}
    if(msg.type==="frame"){
      if(!latest?.ocr || Date.now()-Number(latest.received_at||0)>5000) setImmediate(analyzeLiveFrame);
    }
    if(msg.type==="attachment_start"){
      const file=path.join(uploadDir,crypto.randomUUID()+"_"+safeName(msg.name));
      uploads.set(msg.id,{id:msg.id,name:msg.name,mime:msg.mime,size:msg.size,time:msg.time,chunks:0,complete:false,file});
      fs.writeFileSync(file,Buffer.alloc(0));
    }
    if(msg.type==="attachment_chunk"){
      const u=uploads.get(msg.id);
      if(u&&u.chunks<2000){
       const chunk=Buffer.from(msg.data||"","base64");
       if(fs.statSync(u.file).size+chunk.length<=50*1024*1024)fs.appendFileSync(u.file,chunk);
       u.chunks++;
      }
    }
    if(msg.type==="attachment_end"){
      const u=uploads.get(msg.id);if(u){u.complete=true;broadcast({type:"attachment_received",id:u.id,name:u.name,mime:u.mime,size:u.size,time:Date.now()},socket);analyzeAttachment(u)}
    }
    broadcast(msg,socket);
   }catch{}
  }
 });
 socket.on("close",()=>{clients.delete(socket);log("WS SOCKET CLOSED clients="+clients.size)});
});
setInterval(()=>broadcast({type:"heartbeat",time:Date.now()}),15000);
server.listen(process.env.PORT||8080,"0.0.0.0");
