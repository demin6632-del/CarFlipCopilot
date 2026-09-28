const http=require("http");
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");

const clients=new Set();
const token=process.env.COPILOT_TOKEN||"";
const openaiKey=process.env.OPENAI_API_KEY||"";
const model=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const BUILD_ID="whole-game-mechanics-2026-09-29-1";
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
 try{
  const data=frame(obj);
  for(const c of clients)if(c!==except)c.write(data);
 }catch{}
}
function frame(obj){
 const p=Buffer.from(JSON.stringify(obj));
 if(p.length<126)return Buffer.concat([Buffer.from([129,p.length]),p]);
 if(p.length<65536){const h=Buffer.alloc(4);h[0]=129;h[1]=126;h.writeUInt16BE(p.length,2);return Buffer.concat([h,p])}
 throw new Error("websocket message too large");
}

const {spawnSync}=require("child_process");

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
 if(!openaiKey){
  lastAiError="OPENAI_API_KEY missing";
  log("AI SKIP: OPENAI_API_KEY missing build="+BUILD_ID);
  setAiStatus("Ошибка relay: OPENAI_API_KEY не настроен на сервере");
  return;
 }
 if(aiBusy||!latestFrame)return;
 aiBusy=true;
 const frame=latestFrame; latestFrame=null;
 log("AI START build="+BUILD_ID+" frameBytes="+Buffer.byteLength(frame||"","base64")+" clients="+clients.size);
 lastAiAt=Date.now();
 lastAiError="";
 broadcast({type:"ai_status",message:"ChatGPT анализирует экран игры…"});
 try{
  const state=latest||{};
  // The image is authoritative when OCR conflicts with structured fields; AI must explicitly verify critical values. 
  const verificationRule="Проверяй критические данные (баланс, цена, пробег, мощность, владельцы, ставки, предложения и комиссии) по изображению. Если OCR/структурированное состояние расходится с изображением, доверяй читаемому изображению и помечай значение как уточнённое. Не выдумывай отсутствующие значения.";
  const history=aiHistory.slice(-12);
  const prompt=[
   "Ты — главный игровой помощник пользователя. Именно ты принимаешь решение по игре «Симулятор Перекупа».",
   "Твоя задача — анализировать ВСЮ видимую игровую ситуацию, а не только автомобиль.",
   "На Android есть OCR и локальные парсеры только как источники данных. Их решения НЕ являются авторитетом и игнорируются.",
   "Используй изображение как главный источник истины, OCR/структурированное состояние — как дополнительную расшифровку.",
   "Учитывай баланс, гараж, текущие сделки, предложения покупателей, номера, аукцион номеров, контракты, расходы, награды, соревнования и любые другие видимые события.",
   "Пользователь хочет зарабатывать и продвигать баланс, поэтому ищи реальные возможности, но не выдумывай цену продажи, спрос или расходы.",
   "Если данных недостаточно для безопасного решения — прямо скажи, что именно нужно проверить.",
   "Верни ОДНО главное действие, которое пользователь должен сделать прямо сейчас. Не давай рейтинг вариантов.",
   "Ответь ТОЛЬКО одним корректным JSON-объектом без markdown и без тройных обратных кавычек.",
   "JSON должен иметь поля: action,title,reason,confidence,game_state,sale_price,expected_profit,roi_percent,next_actions,changes. Числовые поля sale_price, expected_profit и roi_percent могут быть null; next_actions и changes — массивы строк.",
   "Если нужно сначала получить данные, действие должно быть конкретным: например ОТКРОЙ, ПРОВЕРЬ, НЕ ПОКУПАЙ или ПОКУПАЙ.",
   "Правило проверки: "+verificationRule,
   "Текущая структурированная информация: "+JSON.stringify(state),
   "Полная сохранённая память игры (факты, сделки, предложения, номера, журнал, ROI): "+JSON.stringify(state.memory||{}),
   "Карта механик игры: "+JSON.stringify(state.mechanics||state.memory?.mechanics||{}),
   "Важно: карта механик содержит только наблюдавшиеся системы. Поля observed=false означают неизвестное, а не отсутствие механики. Не выдумывай скрытые правила.",
   "Рассматривай игру целиком: текущую цель игрока, капитал, прогрессию, гараж, автомобили, покупку, продажу, переговоры, проверки, ремонт/тюнинг, номера, аукцион номеров, контракты, награды, импорт, финансы, бизнесы, работу, соревнования, кланы, рефералы, социальные разделы и рынки.",
   "Предыдущие решения ChatGPT: "+JSON.stringify(history)
  ].join("\n");
  const content=[
   {type:"input_text",text:prompt},
   {type:"input_image",image_url:"data:image/jpeg;base64,"+frame}
  ];
  const body={
   model,
   input:[{role:"user",content}],
   text:{format:{type:"text"}}
  };
  log("AI REQUEST model="+model);
  setAiStatus("Запрос к ChatGPT отправлен • model="+model);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  let r;
  try {
   r=await fetch("https://api.openai.com/v1/responses",{
   method:"POST",
   headers:{"Authorization":"Bearer "+openaiKey,"Content-Type":"application/json"},
   body:JSON.stringify(body),signal:controller.signal
   });
  } finally { clearTimeout(timeout); }
  const data=await r.json();
  const outputText=String(data.output_text||data.output?.flatMap(item=>item.content||[]).filter(x=>typeof x.text==="string").map(x=>x.text).join("")||"");
  log("AI RESPONSE status="+r.status+" outputChars="+outputText.length);
  if(!r.ok)throw new Error(JSON.stringify(data));
  if(!outputText)throw new Error("OpenAI returned empty output");
  let parsed;
  try{parsed=JSON.parse(outputText)}catch(e){throw new Error("Invalid AI JSON: "+String(e.message||e)+" raw="+outputText.slice(0,500))}
  parsed.confidence=Math.max(0,Math.min(100,Number(parsed.confidence)||0));
  aiHistory.push({time:Date.now(),decision:parsed,state:{
   balance:state.balance,garage:state.garage,vehicle:state.vehicle,ocr:state.ocr
  }});
  if(aiHistory.length>30)aiHistory.shift();
  broadcast({type:"ai_decision",decision:parsed,time:Date.now()});
 }catch(e){
  lastAiError=String(e.message||e);
  log("AI ERROR",lastAiError);
  setAiStatus("Ошибка ChatGPT: "+lastAiError.slice(0,240));
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
 if(!openaiKey)return;
 let frameFiles=[];
 try{
  const mime=u.mime||"";
  let content=[{type:"input_text",text:basePrompt(u)}];
  if(mime.startsWith("image/")){
   const b64=fs.readFileSync(u.file).toString("base64");
   content.push({type:"input_image",image_url:"data:"+mime+";base64,"+b64});
  }else if(mime.startsWith("video/")){
   frameFiles=extractVideoFrames(u.file);
   if(frameFiles.length){
    content[0].text+="\nЭто видео. Анализируй последовательность кадров как таймлайн и отмечай изменения между кадрами.";
    for(const f of frameFiles)content.push({type:"input_image",image_url:"data:image/jpeg;base64,"+fs.readFileSync(f).toString("base64")});
   }else content[0].text+="\nВидео не удалось разложить на кадры на сервере. Сообщи это в detected_game_state.";
  }else{
   content[0].text+="\nДля документа/файла используй только фактически доступное содержимое. Если содержимое не передано модели, не выдумывай его.";
  }
  const body={model,input:[{role:"user",content}],text:{format:{type:"json_schema",name:"carflip_attachment_analysis",strict:true,schema:analysisSchema}}};
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+openaiKey,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));
  const raw=data.output_text||"";
  let parsed;try{parsed=JSON.parse(raw)}catch{parsed={attachment_type:mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":"file",detected_game_state:raw,vehicle:null,buyer_offers:[],actions:[],sale_price:null,expected_profit:null,roi_percent:null,confidence:0,changes:[],next_actions:[]}}
  u.analysis=parsed;u.analyzedAt=Date.now();
  broadcast({type:"attachment_analysis",id:u.id,name:u.name,mime:u.mime,analysis:parsed,time:u.analyzedAt});
 }catch(e){
  u.analysisError=String(e.message||e);broadcast({type:"attachment_analysis_error",id:u.id,error:u.analysisError});
 }finally{
  for(const f of frameFiles)try{fs.unlinkSync(f)}catch{}
  if(frameFiles.length)try{fs.rmSync(path.dirname(frameFiles[0]),{recursive:true,force:true})}catch{}
 }
}

const server=http.createServer((req,res)=>{
 if(!auth(req))return json(res,401,{error:"unauthorized"});
 if(req.url==="/health")return json(res,200,{ok:true,build:BUILD_ID,model,clients:clients.size,uploads:uploads.size,ai:!!openaiKey,lastFrameAt,lastAiAt,lastAiStatus,lastAiError:lastAiError?lastAiError.slice(0,500):""});
 if(req.url==="/state")return json(res,200,latest||{});
 if(req.url==="/attachments")return json(res,200,[...uploads.values()].map(({file,...x})=>x));
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
    if(msg.type==="state"){latest=msg;log("STATE balance="+msg.balance+" garage="+msg.garage+" ocr="+String(msg.ocr||"").length);}
    if(msg.type==="frame"){latestFrame=msg.jpegBase64||null;lastFrameAt=Date.now();log("FRAME received bytes="+Buffer.byteLength(latestFrame||"","base64"));setAiStatus("Кадр получен relay • запускаю анализ");}
    if(msg.type==="frame")setImmediate(analyzeLiveFrame);
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
