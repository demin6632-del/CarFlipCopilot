const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const QRCode = require("qrcode");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

class TelegramUserBridge {
  constructor(opts={}) {
    this.apiId = Number(opts.apiId || 0);
    this.apiHash = String(opts.apiHash || "");
    this.gameUsername = String(opts.gameUsername || "m0dsbeamngbot").replace(/^@/,"");
    this.sessionFile = opts.sessionFile || path.join(process.cwd(),"data","telegram-user-session.txt");
    this.publicUrl = String(opts.publicUrl || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/,"");
    this.relayUrl = String(opts.relayUrl || "").replace(/\/$/,"");
    this.relayToken = String(opts.relayToken || "");
    this.onState = typeof opts.onState === "function" ? opts.onState : null;
    this.client = null;
    this.sessions = new Map();
    this.boundChatId = null;
    this.state = { connected:false, game_bot:this.gameUsername };
    this.authPromise = null;
    this.tickets = new Map();
  }

  configured() {
    return this.apiId > 0 && !!this.apiHash;
  }

  loadSession() {
    if (process.env.TELEGRAM_SESSION) return process.env.TELEGRAM_SESSION;
    try { return fs.readFileSync(this.sessionFile,"utf8").trim(); } catch { return ""; }
  }

  saveSession(session) {
    fs.mkdirSync(path.dirname(this.sessionFile),{recursive:true});
    fs.writeFileSync(this.sessionFile,session,{encoding:"utf8",mode:0o600});
  }

  async ensureClient() {
    if (!this.configured()) throw new Error("TELEGRAM_API_ID/TELEGRAM_API_HASH не настроены");
    if (this.client) return this.client;
    this.client = new TelegramClient(new StringSession(this.loadSession()),this.apiId,this.apiHash,{connectionRetries:5});
    await this.client.connect();
    if (await this.client.checkAuthorization()) {
      await this.attach();
    }
    return this.client;
  }

  async attach() {
    if (!this.client) return;
    this.state.connected = await this.client.checkAuthorization();
    if (!this.state.connected) return;
    const me = await this.client.getMe();
    this.state.user_id = String(me.id);
    this.state.username = me.username || null;
    this.state.connected_at = Date.now();
    this.client.addEventHandler(async event => {
      try {
        const msg = event.message;
        const peer = await msg.getChat();
        const username = peer && peer.username ? String(peer.username).replace(/^@/,"").toLowerCase() : "";
        if (username !== this.gameUsername.toLowerCase()) return;
        await this.handleGameMessage(msg);
      } catch (e) {
        console.log("GAME MESSAGE ERROR:",e.message);
      }
    }, new NewMessage({}));
    try {
      await this.client.sendMessage(this.gameUsername,{message:"/start"});
    } catch (e) {
      console.log("GAME START ERROR:",e.message);
      this.state.last_error = e.message;
    }
  }

  createTicket(chatId) {
    const ticket=crypto.randomBytes(24).toString("hex");
    this.tickets.set(ticket,{chatId:String(chatId),expires:Date.now()+10*60*1000});
    return ticket;
  }

  async startAuth(chatId) {
    if (!this.configured()) throw new Error("Сначала настрой TELEGRAM_API_ID и TELEGRAM_API_HASH на сервере");
    if (this.boundChatId && String(this.boundChatId)!==String(chatId)) throw new Error("Мост уже привязан к другому Telegram-пользователю");
    await this.ensureClient();
    if (this.state.connected) {
      this.boundChatId = chatId;
      return {id:null,connected:true};
    }
    const id=crypto.randomBytes(18).toString("hex");
    const record={id,chatId,createdAt:Date.now(),qr:null,expires:0,done:false,error:null};
    this.sessions.set(id,record);
    if (this.authPromise) return {id,connected:false};
    this.authPromise=(async()=>{
      try {
        await this.client.signInUserWithQrCode(
          {apiId:this.apiId,apiHash:this.apiHash},
          {
            qrCode: async ({token,expires})=>{
              record.qr = "tg://login?token="+token.toString("base64url");
              record.expires = Number(expires||0)*1000;
            },
            password: async ()=>{ if(process.env.TELEGRAM_2FA_PASSWORD) return process.env.TELEGRAM_2FA_PASSWORD; throw new Error("Для этого подключения требуется 2FA-пароль. Настрой TELEGRAM_2FA_PASSWORD на сервере."); },
            onError: async err=>{ record.error=err.message; return false; }
          }
        );
        this.saveSession(this.client.session.save());
        record.done=true;
        record.qr=null;
        this.boundChatId=chatId;
        await this.attach();
      } catch(e) {
        record.error=e.message;
      } finally {
        this.authPromise=null;
      }
    })();
    return {id,connected:false};
  }

  getStatus(id) {
    const r=this.sessions.get(id);
    if (!r) return {error:"Сессия подключения не найдена или устарела"};
    return {
      connected:!!r.done || this.state.connected,
      qr:r.qr,
      expires:r.expires,
      error:r.error,
      user:this.state.username||null
    };
  }

  async handleGameMessage(msg) {
    const text=String(msg.message||"").trim();
    const state=parseGameText(text);
    state.raw_message=text.slice(0,12000);
    state.game_bot="@"+this.gameUsername;
    state.connected=true;
    state.received_at=Date.now();
    this.state=Object.assign({},this.state,state);
    await this.publishState(this.state);
    if (this.onState) await this.onState(this.state);
  }

  async publishState(state) {
    if (!this.relayUrl) return;
    const body=JSON.stringify(state);
    const u=new URL(this.relayUrl+"/bridge/state");
    await new Promise((resolve,reject)=>{
      const req=http.request({
        hostname:u.hostname,port:u.port||443,path:u.pathname,method:"POST",
        headers:{"content-type":"application/json","authorization":"Bearer "+this.relayToken,"content-length":Buffer.byteLength(body)}
      },res=>{res.resume();res.on("end",resolve)});
      req.on("error",reject);req.write(body);req.end();
    }).catch(e=>console.log("RELAY STATE ERROR:",e.message));
  }

  async sendGameMessage(message) {
    if (!this.state.connected || !this.client) throw new Error("Игровая Telegram-сессия не подключена");
    return this.client.sendMessage(this.gameUsername,{message:String(message)});
  }

  status() {
    return Object.assign({},this.state,{game_bot:"@"+this.gameUsername,auth_in_progress:!!this.authPromise});
  }
}

function num(s) {
  const x=String(s||"").replace(/\s/g,"").replace(/₽/g,"").replace(/,/g,".");
  const n=Number(x.replace(/[^0-9.-]/g,""));
  return Number.isFinite(n)?n:null;
}

function parseGameText(text) {
  const s=String(text||"");
  const out={};
  const balance=s.match(/(?:баланс|balance)[^0-9]{0,30}([0-9][0-9\s.,]*)/i);
  const garage=s.match(/(?:гараж|garage)[^0-9]{0,30}(\d+)\s*[/\\]\s*(\d+)/i);
  const price=s.match(/(?:цена|стоимость|price)[^0-9]{0,30}([0-9][0-9\s.,]*)/i);
  const hp=s.match(/(?:л\.с\.|лс|hp)[^0-9]{0,20}(\d{2,5})/i);
  const mileage=s.match(/(?:пробег|mileage)[^0-9]{0,20}([0-9][0-9\s.,]*)/i);
  const owners=s.match(/(?:владельц(?:а|ев)|owners)[^0-9]{0,20}(\d+)/i);
  const plate=s.match(/(?:номер|госномер|plate)[^A-ZА-Я0-9]{0,20}([A-ZА-Я]\d{3}[A-ZА-Я]{2}\s?\d{2,3})/i);
  const vehicleLine=s.match(/(?:автомобиль|машина|vehicle)[^:\n]{0,10}[:\-]\s*([^\n]+)/i);
  if(balance) out.balance=num(balance[1]);
  if(garage) out.garage=Number(garage[1])+"/"+Number(garage[2]);
  if(price) out.vehicle=Object.assign({},out.vehicle||{}, {price:num(price[1])});
  if(hp) out.vehicle=Object.assign({},out.vehicle||{}, {hp:Number(hp[1])});
  if(mileage) out.vehicle=Object.assign({},out.vehicle||{}, {mileage:num(mileage[1])});
  if(owners) out.vehicle=Object.assign({},out.vehicle||{}, {owners:Number(owners[1])});
  if(plate) out.vehicle=Object.assign({},out.vehicle||{}, {plate:plate[1]});
  if(vehicleLine) out.vehicle=Object.assign({},out.vehicle||{}, {name:vehicleLine[1].trim()});
  out.source="telegram_user_session";
  out.confidence=(balance||garage||price||vehicleLine)?0.7:0.25;
  return out;
}

function createConnectServer(bridge, port=8787) {
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,"http://localhost");
    res.setHeader("cache-control","no-store");
    if(u.pathname==="/connect") {
      res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
      res.end(connectHtml());
      return;
    }
    if(u.pathname==="/connect/start" && req.method==="POST") {
      let body="";req.on("data",c=>body+=c);req.on("end",async()=>{
        try{
          const j=JSON.parse(body||"{}");
          const r=await bridge.startAuth(String(j.chat_id||""));
          res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(r));
        }catch(e){res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({error:e.message}))}
      });return;
    }
    if(u.pathname==="/connect/status") {
      const r=bridge.getStatus(u.searchParams.get("id")||"");
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(r));return;
    }
    if(u.pathname==="/connect/qr") {
      const id=u.searchParams.get("id")||"";
      const r=bridge.getStatus(id);
      if(!r.qr)return res.end();
      try{
        const png=await QRCode.toBuffer(r.qr,{width:360,margin:2});
        res.writeHead(200,{"content-type":"image/png","cache-control":"no-store"});res.end(png);
      }catch(e){res.writeHead(500);res.end(e.message)}
      return;
    }
    res.writeHead(404);res.end("not found");
  });
  server.listen(port,"0.0.0.0",()=>console.log("Telegram user bridge web listening on",port));
  return server;
}

function connectHtml() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CarFlipCopilot — подключение</title>
<style>body{font-family:system-ui;margin:0;background:#111;color:#fff;text-align:center;padding:24px}main{max-width:520px;margin:auto}button{padding:12px 18px;border:0;border-radius:12px;font-size:16px}#qr{width:360px;max-width:90vw;background:#fff;padding:8px;border-radius:12px;display:none}a{color:#7dc4ff;word-break:break-all}</style>
<main><h2>🔗 Подключение игры</h2><p id="status">Подготавливаю защищённую сессию…</p><img id="qr"><p id="link"></p><button id="open" style="display:none">Открыть Telegram</button></main>
<script>
const p=new URLSearchParams(location.search),ticket=p.get("ticket");let id="";
async function start(){const r=await fetch("/connect/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});const j=await r.json();if(j.error){status.textContent="Ошибка: "+j.error;return}if(j.connected){status.textContent="✅ Уже подключено";return}id=j.id;poll()}
async function poll(){const j=await (await fetch("/connect/status?id="+encodeURIComponent(id))).json();if(j.error){status.textContent=j.error;return}if(j.connected){status.textContent="✅ Telegram-сессия подключена. Можно вернуться в бота.";qr.style.display="none";return}if(j.qr){qr.src="/connect/qr?id="+encodeURIComponent(id)+"&t="+Date.now();qr.style.display="inline-block";link.innerHTML="Если используешь другое устройство, отсканируй QR в Telegram.<br><small>"+j.qr+"</small>";open.style.display="inline-block";open.onclick=()=>location.href=j.qr}status.textContent="Открой Telegram на другом устройстве и отсканируй QR-код. Код обновляется автоматически.";setTimeout(poll,2500)}
start();
</script>`;
}

module.exports={TelegramUserBridge,createConnectServer,parseGameText};
