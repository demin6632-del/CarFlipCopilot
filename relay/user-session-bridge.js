const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { Client: PgClient } = require("pg");
const keepAliveAgent = new https.Agent({keepAlive:true,maxSockets:16,maxFreeSockets:4,timeout:60000,freeSocketTimeout:15000});
const QRCode = require("qrcode");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { EditedMessage } = require("telegram/events/EditedMessage");
const { normalizeScreenText, normalizeButtons, screenFingerprint, isDuplicateScreen, chooseStableState, classifyScreen } = require("./safety-guard");

const OP_TIMEOUTS={
  telegramRead:8000,
  telegramWrite:10000,
  callback:10000,
  media:10000,
  eventPipeline:12000
};

function withTimeout(promise,ms,label){
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error(label+" timeout after "+ms+"ms")),ms); })
  ]).finally(()=>clearTimeout(timer));
}
const diagnostics=require("./diagnostics");

class TelegramUserBridge {
  constructor(opts={}) {
    this.apiId = Number(opts.apiId || 0);
    this.apiHash = String(opts.apiHash || "");
    this.gameUsername = String(opts.gameUsername || "m0dsbeamngbot").replace(/^@/,"");
    this.gamePeerId = null;
    this.sessionFile = opts.sessionFile || path.join(process.cwd(),"data","telegram-user-session.txt");
    this.publicUrl = String(opts.publicUrl || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/,"");
    this.relayUrl = String(opts.relayUrl || "").replace(/\/$/,"");
    this.relayToken = String(opts.relayToken || "");
    this.onState = typeof opts.onState === "function" ? opts.onState : null;
    this.client = null;
    this.attachedClient = null;
    this.sessions = new Map();
    this.boundChatId = null;
    this.state = { connected:false, game_bot:this.gameUsername };
    this.authPromise = null;
    this.bindingFile = opts.bindingFile || path.join(process.cwd(),"data","telegram-user-binding.json");
    this.loadBinding();
    this.tickets = new Map();
    this.lastGameMessage = null;
    this.gameMessages = [];
    this.gamePollTimer = null;
    this.lastPolledGameKey = "";
    this.gamePollInFlight = false;
    this.gameMessageQueue = Promise.resolve();
    this.webhookHandler = null;
    this.phoneAuth = new Map();
    this.databaseUrl = String(opts.databaseUrl || process.env.DATABASE_URL || "").trim();
    // Load the persistent binding asynchronously; local file remains a fast fallback.
    this.bindingReady = this.loadBindingFromDatabase();
  }

  configured() {
    return this.apiId > 0 && !!this.apiHash;
  }

  async loadSession() {
    // Render's filesystem is ephemeral. Always prefer the latest session
    // persisted in Postgres so a deploy/restart never forces Telegram login again.
    if (this.databaseUrl) {
      try {
        const db=new PgClient({connectionString:this.databaseUrl,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
        await db.connect();
        await db.query("CREATE TABLE IF NOT EXISTS copilot_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
        const r=await db.query("SELECT value FROM copilot_state WHERE key=$1",["telegram_session"]);
        await db.end();
        if (r.rows[0] && r.rows[0].value) return r.rows[0].value;
      } catch(e) { console.log("SESSION DB LOAD ERROR:",e.message); }
    }
    if (process.env.TELEGRAM_SESSION) return process.env.TELEGRAM_SESSION;
    try { return fs.readFileSync(this.sessionFile,"utf8").trim(); } catch { return ""; }
  }

  async saveSession(session) {
    const value=String(session||"").trim();
    if (this.databaseUrl && value) {
      try {
        const db=new PgClient({connectionString:this.databaseUrl,ssl:{rejectUnauthorized:false}});
        await db.connect();
        await db.query("CREATE TABLE IF NOT EXISTS copilot_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
        await db.query("INSERT INTO copilot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",["telegram_session",value]);
        await db.end();
        console.log("TELEGRAM SESSION SAVED TO DATABASE");
      } catch(e) { console.log("SESSION DB SAVE ERROR:",e.message); }
    }
    fs.mkdirSync(path.dirname(this.sessionFile),{recursive:true});
    fs.writeFileSync(this.sessionFile,value,{encoding:"utf8",mode:0o600});
  }

  loadBinding() {
    try {
      const raw=fs.readFileSync(this.bindingFile,"utf8");
      const data=JSON.parse(raw);
      if (data && data.chatId != null) this.boundChatId=String(data.chatId);
    } catch {}
  }

  async loadBindingFromDatabase() {
    if (!this.databaseUrl) return;
    try {
      const db=new PgClient({connectionString:this.databaseUrl,ssl:{rejectUnauthorized:false}});
      await db.connect();
      await db.query("CREATE TABLE IF NOT EXISTS copilot_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
      const r=await db.query("SELECT value FROM copilot_state WHERE key=$1",["telegram_binding"]);
      await db.end();
      if (r.rows[0]?.value) this.boundChatId=String(r.rows[0].value);
    } catch(e) { console.log("BINDING DB LOAD ERROR:",e.message); }
  }

  saveBinding(chatId) {
    this.boundChatId=String(chatId);
    fs.mkdirSync(path.dirname(this.bindingFile),{recursive:true});
    fs.writeFileSync(this.bindingFile,JSON.stringify({chatId:this.boundChatId,updatedAt:Date.now()}),{encoding:"utf8",mode:0o600});
    if (this.databaseUrl) {
      const db=new PgClient({connectionString:this.databaseUrl,ssl:{rejectUnauthorized:false}});
      db.connect().then(async()=>{
        await db.query("CREATE TABLE IF NOT EXISTS copilot_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
        await db.query("INSERT INTO copilot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",["telegram_binding",this.boundChatId]);
        await db.end();
      }).catch(e=>console.log("BINDING DB SAVE ERROR:",e.message));
    }
  }

  async ensureClient() {
    if (this.bindingReady) await this.bindingReady;
    if (!this.configured()) throw new Error("TELEGRAM_API_ID/TELEGRAM_API_HASH не настроены");
    if (this.client) return this.client;
    const session=await this.loadSession();
    console.log("TELEGRAM SESSION SOURCE:", session ? "restored" : "empty");
    const client=new TelegramClient(new StringSession(session),this.apiId,this.apiHash,{connectionRetries:2});
    this.client=client;
    try {
      await Promise.race([
        client.connect(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("Подключение Telegram не ответило за 15 секунд")),15000))
      ]);
      if (await Promise.race([
        client.checkAuthorization(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("Проверка авторизации Telegram превысила 10 секунд")),10000))
      ])) {
        await this.attach();
        try { await this.saveSession(client.session.save()); } catch(e) { console.log("SESSION REFRESH SAVE ERROR:",e.message); }
      }
      return client;
    } catch (e) {
      try { await client.disconnect(); } catch {}
      if (this.client===client) this.client=null;
      throw e;
    }
  }

  async attach() {
    if (!this.client) return;
    this.state.connected = await this.client.checkAuthorization();
    if (!this.state.connected) return;
    if (this.attachedClient === this.client) return;
    const me = await withTimeout(this.client.getMe(),OP_TIMEOUTS.telegramRead,"TELEGRAM GET ME");
    this.state.user_id = String(me.id);
    try {
      const game = await withTimeout(this.client.getEntity(this.gameUsername),OP_TIMEOUTS.telegramRead,"TELEGRAM RESOLVE GAME");
      this.gamePeerId = game && game.id != null ? String(game.id) : null;
      console.log("GAME PEER RESOLVED:", this.gameUsername, this.gamePeerId || "unknown");
    } catch(e) {
      this.gamePeerId = null;
      console.log("GAME PEER RESOLVE ERROR:", e.message);
    }
    this.state.username = me.username || null;
    this.state.connected_at = Date.now();
    const handleEvent = async event => {
      try {
        const msg = event.message;
        const peer = await withTimeout(msg.getChat(),5000,"GAME CHAT RESOLVE");
        const peerUsername = peer && peer.username ? String(peer.username).replace(/^@/,"").toLowerCase() : "";
        const expectedUsername = String(this.gameUsername || "").replace(/^@/,"").toLowerCase();
        const peerId = peer && peer.id != null ? String(peer.id) : (msg.senderId != null ? String(msg.senderId) : "");
        const sameById = !!(this.gamePeerId && peerId && this.gamePeerId === peerId);
        const sameByUsername = !!(expectedUsername && peerUsername && peerUsername === expectedUsername);
        if (!sameById && !sameByUsername) return;
        await this.enqueueGameMessage(msg);
      } catch (e) {
        console.log("GAME MESSAGE ERROR:",e.stack||e.message||e);
      }
    };
    // The game can either send a new message or edit the existing screen
    // after a callback. Handle both so the in-chat game stays live.
    this.client.addEventHandler(handleEvent, new NewMessage({}));
    this.client.addEventHandler(handleEvent, new EditedMessage({}));
    this.attachedClient = this.client;
    this.startGamePolling();
    // Do not send /start automatically on startup or session restore.
    // The game is pinged only by the explicit "Проверить связь с игрой" action.
  }

  startGamePolling() {
    if(this.gamePollTimer || !this.client || !this.state.connected || !this.gameUsername)return;
    // Event handlers are the fast path. This low-frequency poll is a safety net
    // for Telegram/GramJS cases where a bot message or edited message event is
    // missed while the process is reconnecting.
    this.gamePollTimer=setInterval(async()=>{
      if(this.gamePollInFlight)return;
      this.gamePollInFlight=true;
      try{
        // Poll only the current game screen. Never overlap Telegram reads:
        // an unresolved GramJS request must not create a growing pile of
        // concurrent requests that makes the bot appear frozen.
        const msgs=await withTimeout(
          this.client.getMessages(this.gameUsername,{limit:1}),
          OP_TIMEOUTS.telegramRead,
          "GAME POLL"
        );
        const list=Array.isArray(msgs)?msgs:[msgs];
        const msg=list[0];
        if(msg && (String(msg.message||"").trim() || (msg.replyMarkup&&msg.replyMarkup.rows))){
          // The current screen is polled only as a fallback. Do not feed the
          // same unchanged message into the pipeline every 1.5s.
          const pollKey=String(msg.id||"")+"|"+String(msg.editDate||"")+"|"+String(msg.message||"")+"|"+JSON.stringify(msg.replyMarkup?.rows||[]);
          if(pollKey!==this.lastPolledGameKey){
            this.lastPolledGameKey=pollKey;
            await this.enqueueGameMessage(msg);
          }
        }
      }catch(e){
        console.log("GAME POLL ERROR:",e.message);
      }finally{
        this.gamePollInFlight=false;
      }
    },1500);
    if(this.gamePollTimer.unref)this.gamePollTimer.unref();
  }

  createTicket(chatId) {
    const ticket=crypto.randomBytes(24).toString("hex");
    this.tickets.set(ticket,{chatId:String(chatId),expires:Date.now()+10*60*1000});
    return ticket;
  }

  resolveChatId(value) {
    const key=String(value||"").trim();
    if (!key) throw new Error("Не указан Telegram chat_id или ticket");
    const ticket=this.tickets.get(key);
    if (ticket) {
      if (ticket.expires < Date.now()) {
        this.tickets.delete(key);
        throw new Error("Ссылка подключения устарела. Открой «Подключить игру» ещё раз.");
      }
      this.tickets.delete(key);
      return ticket.chatId;
    }
    return key;
  }

  async startAuth(chatIdOrTicket) {
    if (!this.configured()) throw new Error("Сначала настрой TELEGRAM_API_ID и TELEGRAM_API_HASH на сервере");
    const chatId=this.resolveChatId(chatIdOrTicket);
    if (this.boundChatId && String(this.boundChatId)!==String(chatId)) throw new Error("Мост уже привязан к другому Telegram-пользователю");
    if (this.state.connected) {
      this.saveBinding(chatId);
      return {id:null,connected:true};
    }
    const id=crypto.randomBytes(18).toString("hex");
    const record={id,chatId,createdAt:Date.now(),qr:null,expires:0,done:false,error:null};
    this.sessions.set(id,record);
    if (this.authPromise) return {id,connected:false};
    this.authPromise=(async()=>{
      try {
        await this.ensureClient();
        if (this.state.connected) {
          record.done=true;
          this.saveBinding(chatId);
          return;
        }
        await Promise.race([
          this.client.signInUserWithQrCode(
          {apiId:this.apiId,apiHash:this.apiHash},
          {
            qrCode: async ({token,expires})=>{
              record.qr = "tg://login?token="+token.toString("base64url");
              record.expires = Number(expires||0)*1000;
            },
            password: async ()=>{ if(process.env.TELEGRAM_2FA_PASSWORD) return process.env.TELEGRAM_2FA_PASSWORD; throw new Error("Для этого подключения требуется 2FA-пароль. Настрой TELEGRAM_2FA_PASSWORD на сервере."); },
            onError: async err=>{ record.error=err.message; return false; }
          }
        ),
          new Promise((_,reject)=>setTimeout(()=>reject(new Error("Авторизация по QR не завершилась за 10 минут")),10*60*1000))
        ]);
        await this.saveSession(this.client.session.save());
        record.done=true;
        record.qr=null;
        this.saveBinding(chatId);
        await this.attach();
      } catch(e) {
        record.error=e.message;
      } finally {
        this.authPromise=null;
      }
    })();
    return {id,connected:false};
  }

  async startPhoneAuth(chatIdOrTicket, phone) {
    if (!this.configured()) throw new Error("Сначала настрой TELEGRAM_API_ID и TELEGRAM_API_HASH на сервере");
    const chatId=this.resolveChatId(chatIdOrTicket);
    if (this.boundChatId && String(this.boundChatId)!==String(chatId)) throw new Error("Мост уже привязан к другому Telegram-пользователю");
    await this.ensureClient();
    if (this.state.connected) { this.saveBinding(chatId); return {connected:true}; }
    const normalized=String(phone||"").trim();
    if (!/^\+?[0-9][0-9 ()-]{5,20}$/.test(normalized)) throw new Error("Укажи номер телефона в международном формате, например +79991234567");
    const sent=await this.client.sendCode({apiId:this.apiId,apiHash:this.apiHash},normalized);
    const id=crypto.randomBytes(18).toString("hex");
    this.phoneAuth.set(id,{id,chatId,phone:normalized,phoneCodeHash:sent.phoneCodeHash,createdAt:Date.now(),expires:Date.now()+10*60*1000});
    return {id,connected:false,codeSent:true};
  }

  async verifyPhoneAuth(id, code, password) {
    const r=this.phoneAuth.get(String(id||""));
    if (!r || r.expires<Date.now()) { if(r)this.phoneAuth.delete(String(id||"")); throw new Error("Сессия входа устарела. Начни подключение заново."); }
    const cleanCode=String(code||"").replace(/\s/g,"");
    if (!cleanCode) throw new Error("Введи код из Telegram");
    try {
      await this.client.invoke(new Api.auth.SignIn({phoneNumber:r.phone,phoneCodeHash:r.phoneCodeHash,phoneCode:cleanCode}));
    } catch (e) {
      if (e && (e.errorMessage==="SESSION_PASSWORD_NEEDED" || e.message==="SESSION_PASSWORD_NEEDED")) {
        const pw=String(password||"");
        if (!pw) return {id:r.id,connected:false,needsPassword:true};
        await this.client.signInWithPassword({apiId:this.apiId,apiHash:this.apiHash},{password:async()=>pw,onError:async err=>{ console.log("TELEGRAM 2FA ERROR:",err.message); return true; }});
      } else throw e;
    }
    await this.saveSession(this.client.session.save());
    this.saveBinding(r.chatId);
    this.phoneAuth.delete(String(id));
    await this.attach();
    return {id:r.id,connected:true,user:this.state.username||null};
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

  enqueueGameMessage(msg) {
    // A single broken DB/Telegram operation must never poison the per-game
    // queue forever. Advance the queue after a hard watchdog timeout.
    const run=this.gameMessageQueue.catch(()=>{}).then(()=>withTimeout(
      this.handleGameMessage(msg),
      OP_TIMEOUTS.eventPipeline + 3000,
      "GAME SCREEN PIPELINE"
    ));
    this.gameMessageQueue=run.catch(e=>{
      diagnostics.inc("screen.pipeline_timeout");
      console.log("GAME SCREEN QUEUE ERROR:",e.stack||e.message||e);
    });
    return run;
  }

  async handleGameMessage(msg) {
    const pipelineStarted=Date.now();
    diagnostics.inc("screen.received");
    const receivedAt=Date.now();
    const text=normalizeScreenText(String(msg.message||""));
    const buttons=[];
    try {
      const seen=new Set();
      const addButton=(b)=>{
        const label=String(b?.text||b||"").trim();
        if(label&&!seen.has(label)){seen.add(label);buttons.push(label);}
      };
      const rows=msg.replyMarkup && Array.isArray(msg.replyMarkup.rows) ? msg.replyMarkup.rows : [];
      for(const row of rows) for(const b of (row?.buttons||[])) addButton(b);
      if(!buttons.length && Array.isArray(msg.buttons)){
        for(const row of msg.buttons) {
          if(Array.isArray(row)) for(const b of row) addButton(b);
          else addButton(row);
        }
      }
    } catch(e) { console.log("GAME BUTTON PARSE ERROR:",e.message); }

    const cleanButtons=normalizeButtons(buttons);
    const fingerprint=screenFingerprint(text,cleanButtons);
    const current={fingerprint,receivedAt};
    const previous=this.lastGameMessage && {
      fingerprint:this.lastGameMessage.fingerprint,
      receivedAt:this.lastGameMessage.received_at
    };
    if(isDuplicateScreen(previous,current,15000)){
      diagnostics.inc("screen.duplicate");
      console.log("GAME SCREEN DUPLICATE IGNORED:",msg.id!=null?String(msg.id):"unknown");
      return;
    }

    const parsed=parseGameText(text);
    const stable=chooseStableState(this.state && this.state.raw_message ? this.state : null,parsed);
    if(!stable.accepted){
      diagnostics.inc("ocr.rejected");
      console.log("GAME OCR GUARD:",stable.check.warnings.join(","),msg.id!=null?String(msg.id):"unknown");
    }
    const state=Object.assign({},stable.state,parsed);
    if(!stable.accepted && this.state){
      for(const key of ["balance","garage","plate","vehicle","price","mileage","hp","owners","contexts","money_values"]){
        if(this.state[key]!==undefined) state[key]=this.state[key];
      }
    }

    state.buttons=cleanButtons;
    state.raw_message=text.slice(0,12000);
    state.raw_text=text.slice(0,16000);
    this.lastGameMessage={
      message_id:msg.id!=null?String(msg.id):null,
      text:state.raw_message,
      buttons:cleanButtons,
      fingerprint,
      screen_class:classifyScreen(text),
      received_at:receivedAt
    };
    this.gameMessages.push(this.lastGameMessage);
    if(this.gameMessages.length>20) this.gameMessages.shift();
    state.game_bot="@"+this.gameUsername;
    state.connected=true;
    state.received_at=receivedAt;
    this.state=Object.assign({},this.state,state);
    diagnostics.inc("screen.accepted");
    diagnostics.observe("screen.pipeline",Date.now()-pipelineStarted);
    this.publishState(this.state).catch(e=>{ diagnostics.inc("relay.publish_error"); console.log("RELAY STATE ASYNC ERROR:",e.message); });
    if (this.onState) {
      try { await withTimeout(this.onState(this.state),OP_TIMEOUTS.eventPipeline,"GAME STATE NOTIFY"); }
      catch (e) { console.log("GAME STATE NOTIFY ERROR:", e.stack||e.message||e); }
    }
  }
  async publishState(state) {
    if (!this.relayUrl) return;
    const body=JSON.stringify(state);
    const u=new URL(this.relayUrl+"/bridge/state");
    const transport=u.protocol==="https:"?https:http;
    await new Promise((resolve,reject)=>{
      const req=transport.request({
        protocol:u.protocol,hostname:u.hostname,port:u.port||undefined,path:u.pathname+u.search,method:"POST",agent:keepAliveAgent,
        headers:{"content-type":"application/json","authorization":"Bearer "+this.relayToken,"content-length":Buffer.byteLength(body)}
      },res=>{
        res.resume();
        res.on("end",()=>{
          if(res.statusCode>=200 && res.statusCode<300) return resolve();
          reject(new Error("Relay state HTTP "+String(res.statusCode||0)));
        });
      });
      req.on("error",reject);
      req.setTimeout(10000,()=>req.destroy(new Error("Relay state timeout")));
      req.write(body);req.end();
    }).catch(e=>console.log("RELAY STATE ERROR:",e.message));
  }

  async sendGameMessage(message) {
    if (!this.state.connected || !this.client) throw new Error("Игровая Telegram-сессия не подключена");
    const before = this.lastGameMessage && Number(this.lastGameMessage.message_id) || 0;
    const startedAt=Date.now();
    const sent = await withTimeout(
      this.client.sendMessage(this.gameUsername,{message:String(message)}),
      OP_TIMEOUTS.telegramWrite,
      "GAME SEND"
    );
    // NewMessage and EditedMessage are both valid game responses. An edited
    // screen keeps the same message ID, so waiting only for id > before can
    // miss the fresh screen entirely.
    const responseDeadline=startedAt+12000;
    for (let attempt=0; attempt<6 && Date.now()<responseDeadline; attempt++) {
      await new Promise(r=>setTimeout(r,250));
      if(this.lastGameMessage && Number(this.lastGameMessage.received_at||0)>=startedAt)return sent;
      try {
        const remaining=Math.max(1000,Math.min(OP_TIMEOUTS.telegramRead,responseDeadline-Date.now()));
        const msgs=await withTimeout(this.client.getMessages(this.gameUsername,{limit:6}),remaining,"GAME RESPONSE POLL");
        const list=Array.isArray(msgs)?msgs:[msgs];
        const candidates=list
          .filter(m=>m && Number(m.id||0)>=before && String(m.message||"").trim())
          .sort((a,b)=>Number(a.id||0)-Number(b.id||0));
        for (const msg of candidates) await this.enqueueGameMessage(msg);
        if (candidates.length) {
          if(this.lastGameMessage && Number(this.lastGameMessage.received_at||0)>=startedAt)return sent;
          break;
        }
      } catch(e) {
        console.log("GAME RESPONSE POLL ERROR:",e.message);
      }
    }
    return sent;
  }

  async getGameButton(messageId,key) {
    if (!this.state.connected || !this.client) throw new Error("Игровая Telegram-сессия не подключена");
    const targetMessageId=Number(messageId);
    if (!Number.isFinite(targetMessageId)) return null;
    const msgs=await withTimeout(this.client.getMessages(this.gameUsername,{ids:[targetMessageId]}),OP_TIMEOUTS.telegramRead,"GAME BUTTON READ");
    const msg=Array.isArray(msgs) ? msgs[0] : msgs;
    if (!msg) return null;
    const candidates=[];
    const add=(b)=>{if(b)candidates.push(b);};
    const rows=msg.replyMarkup && Array.isArray(msg.replyMarkup.rows) ? msg.replyMarkup.rows : [];
    for(const row of rows) for(const button of (row?.buttons||[])) add(button);
    if(!candidates.length && Array.isArray(msg.buttons)){
      for(const row of msg.buttons) {
        if(Array.isArray(row)) for(const button of row) add(button);
        else add(row);
      }
    }
    for(const button of candidates) {
      const label=String(button?.text||"").trim();
      if(label && require("crypto").createHash("sha256").update(label).digest("hex").slice(0,16)===String(key)) return label;
    }
    return null;
  }

  async clickGameButton(label,messageId=null) {
    if (!this.state.connected || !this.client) throw new Error("Игровая Telegram-сессия не подключена");
    const target=String(label||"").trim();
    if (!target) throw new Error("Не указана кнопка");

    // The callback belongs to the exact Telegram message that contained the
    // game button. Do not reject it just because the game has already sent a
    // newer message in the meantime.
    const latest=this.lastGameMessage;
    const targetMessageId=messageId!=null?String(messageId):String(latest?.message_id||"");
    if (!targetMessageId) throw new Error("Нет сообщения игры");
    if (messageId==null && (!latest || !Array.isArray(latest.buttons) || !latest.buttons.includes(target))) {
      throw new Error("Кнопка устарела или уже исчезла: "+target);
    }
    const numericMessageId=Number(targetMessageId);
    if (!Number.isFinite(numericMessageId)) throw new Error("Некорректный ID сообщения игры");
    const msgs=await withTimeout(this.client.getMessages(this.gameUsername,{ids:[numericMessageId]}),OP_TIMEOUTS.telegramRead,"GAME BUTTON READ");
    const msg=Array.isArray(msgs) ? msgs[0] : msgs;
    if (!msg) throw new Error("Сообщение игры больше недоступно");

    const candidates=[];
    const add=(b)=>{if(b)candidates.push(b);};
    const rows=msg.replyMarkup && Array.isArray(msg.replyMarkup.rows) ? msg.replyMarkup.rows : [];
    for(const row of rows) for(const button of (row?.buttons||[])) add(button);
    if(!candidates.length && Array.isArray(msg.buttons)){
      for(const row of msg.buttons) {
        if(Array.isArray(row)) for(const button of row) add(button);
        else add(row);
      }
    }
    for(const button of candidates) {
      if (String(button?.text||"").trim()!==target) continue;

      // Game bots normally use callback buttons. Calling the MTProto method
      // directly is more reliable than Message.click(), which can vary by
      // GramJS version and may not dispatch the callback for bot keyboards.
      const data=button.data;
      if (data && typeof this.client.invoke==="function") {
        const peer=await this.client.getInputEntity(this.gameUsername);
        const result=await withTimeout(this.client.invoke(new Api.messages.GetBotCallbackAnswer({
          peer,
          msgId:numericMessageId,
          data
        })),OP_TIMEOUTS.callback,"GAME BUTTON CALLBACK");
        console.log("GAME BUTTON CALLBACK:", target, "message", numericMessageId);
        return result;
      }

      if (typeof msg.click==="function") {
        try { return await withTimeout(msg.click({text:target}),OP_TIMEOUTS.callback,"MESSAGE CLICK"); } catch(e) { console.log("MESSAGE CLICK FALLBACK ERROR:",e.message); }
      }
      if (typeof msg.clickButton==="function") return withTimeout(msg.clickButton(button),OP_TIMEOUTS.callback,"MESSAGE CLICK BUTTON");
    }
    throw new Error("Кнопка не найдена в сообщении игры: "+target);
  }

  async getGameMedia(messageId) {
    if (!this.client || messageId == null) return null;
    try {
      const msgs=await this.client.getMessages(this.gameUsername,{ids:[Number(messageId)]});
      const msg=Array.isArray(msgs)?msgs[0]:msgs;
      if (!msg || !msg.media || typeof msg.downloadMedia !== "function") return null;
      const buffer=await withTimeout(msg.downloadMedia({workers:1}),OP_TIMEOUTS.media,"GAME MEDIA");
      if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) return null;
      return buffer;
    } catch(e) {
      console.log("GAME MEDIA ERROR:",e.message);
      return null;
    }
  }

  status() {
    return Object.assign({},this.state,{game_bot:"@"+this.gameUsername,auth_in_progress:!!this.authPromise,last_game_message:this.lastGameMessage,diagnostics:diagnostics.snapshot()});
  }

  async shutdown() {
    this.state.connected=false;
    try { if (this.client) await this.client.disconnect(); } catch (e) { console.log("TELEGRAM CLIENT SHUTDOWN ERROR:",e.message); }
    this.client=null;
  }

  recentGameMessages(limit=10) {
    return this.gameMessages.slice(-Math.max(1,Math.min(20,Number(limit)||10)));
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

  // Game messages are not guaranteed to use literal labels. Some screens
  // expose the same values as emoji + value, so support both formats.
  const money = value => {
    const raw=String(value||"").replace(/[^0-9]/g,"");
    const n=Number(raw);
    return Number.isSafeInteger(n)?n:null;
  };

  const balancePatterns=[
    /(?:баланс|balance|сч[её]т|деньги|денег|наличн(?:ые|ых)?)\\s*[:：-]?\\s*[^0-9]{0,20}([0-9][0-9\\s.,]*)/i,
    /(?:💰|💵)\\s*(?:баланс\\s*[:：-]?\\s*)?([0-9][0-9\\s.,]*)\\s*(?:₽|руб(?:\\.|лей)?|RUB)?/i
  ];
  const garagePatterns=[
    /(?:гараж|garage)\\s*[:：-]?\\s*[^0-9]{0,20}(\\d+)\\s*[/\\\\|]\\s*(\\d+)/i,
    /(?:🚗|🏠)\\s*(?:гараж\\s*[:：-]?\\s*)?(\\d+)\\s*[/\\\\|]\\s*(\\d+)/i
  ];

  let balanceMatch=null;
  for(const re of balancePatterns){ const m=s.match(re); if(m){ balanceMatch=m; break; } }
  let garageMatch=null;
  for(const re of garagePatterns){ const m=s.match(re); if(m){ garageMatch=m; break; } }

  const price=s.match(/(?:цена|стоимость|price|стоимость\\s*авто|цена\\s*авто)[^0-9]{0,40}([0-9][0-9\\s.,]*)/i);
  const hp=s.match(/(?:л\\.?\\s*с\\.?|лс|hp)[^0-9]{0,20}(\\d{2,5})/i);
  const mileage=s.match(/(?:пробег|mileage)[^0-9]{0,20}([0-9][0-9\\s.,]*)/i);
  const owners=s.match(/(?:владельц(?:а|ев)?|владельцев|owners)[^0-9]{0,20}(\\d+)/i);
  const plate=s.match(/(?:номер|госномер|гос\\.?\\s*номер|plate)[^A-ZА-Я0-9]{0,20}([A-ZА-Я]\\s*\\d{3}\\s*[A-ZА-Я]{2}\\s*\\d{2,3})/i);
  const vehicleLine=s.match(/(?:автомобиль|машина|vehicle)\\s*[:：-]\\s*([^\n]+)/i);

  if(balanceMatch) out.balance=money(balanceMatch[1]);
  if(garageMatch) out.garage=Number(garageMatch[1])+"/"+Number(garageMatch[2]);
  if(price) out.vehicle=Object.assign({},out.vehicle||{}, {price:money(price[1])});
  if(hp) out.vehicle=Object.assign({},out.vehicle||{}, {hp:Number(hp[1])});
  if(mileage) out.vehicle=Object.assign({},out.vehicle||{}, {mileage:money(mileage[1])});
  if(owners) out.vehicle=Object.assign({},out.vehicle||{}, {owners:Number(owners[1])});
  if(plate) out.vehicle=Object.assign({},out.vehicle||{}, {plate:plate[1].replace(/\\s+/g," ")});
  if(vehicleLine) out.vehicle=Object.assign({},out.vehicle||{}, {name:vehicleLine[1].trim()});

  out.source="telegram_user_session";
  out.confidence=(balanceMatch||garageMatch||price||vehicleLine)?0.9:0.25;
  return out;
}

function createConnectServer(bridge, port=8787, options={}) {
  const webhookSecret=String(options.webhookSecret||"");
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,"http://localhost");
    res.setHeader("cache-control","no-store");
    if(u.pathname==="/telegram/webhook" && req.method==="POST") { const providedSecret=String(req.headers["x-telegram-bot-api-secret-token"]||""); if(webhookSecret && providedSecret!==webhookSecret){ res.writeHead(403,{"content-type":"application/json"}); res.end(JSON.stringify({ok:false,error:"forbidden"})); return; }
      let body="";
      req.on("data",chunk=>{ if(body.length<2*1024*1024) body+=chunk.toString(); });
      req.on("end",async()=>{
        try {
          const update=JSON.parse(body||"{}");
          res.writeHead(200,{"content-type":"application/json"});
          res.end(JSON.stringify({ok:true}));
          if(typeof bridge.webhookHandler==="function") {
            Promise.resolve().then(()=>bridge.webhookHandler(update)).catch(e=>
              console.log("TELEGRAM ASYNC UPDATE ERROR:",e.stack||e.message||e)
            );
          }
        } catch(e) {
          console.log("TELEGRAM WEBHOOK ERROR:",e.stack||e.message||e);
          res.writeHead(200,{"content-type":"application/json"});
          res.end(JSON.stringify({ok:false}));
        }
      });
      return;
    }
    if(u.pathname==="/health") {
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({ok:true,service:"carflip-copilot-telegram"}));
      return;
    }
    if(u.pathname==="/connect") {
      res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
      res.end(connectHtml());
      return;
    }
    if(u.pathname==="/connect/start" && req.method==="POST") {
      let body="";req.on("data",c=>body+=c);req.on("end",async()=>{
        try{
          const j=JSON.parse(body||"{}");
          const r=await bridge.startAuth(String(j.ticket||j.chat_id||""));
          res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(r));
        }catch(e){res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({error:e.message}))}
      });return;
    }

    if(u.pathname==="/connect/phone/start" && req.method==="POST") {
      let body="";req.on("data",c=>body+=c);req.on("end",async()=>{
        try{
          const j=JSON.parse(body||"{}");
          const r=await bridge.startPhoneAuth(String(j.ticket||j.chat_id||""),String(j.phone||""));
          res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(r));
        }catch(e){res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({error:e.message}))}
      });return;
    }
    if(u.pathname==="/connect/phone/verify" && req.method==="POST") {
      let body="";req.on("data",c=>body+=c);req.on("end",async()=>{
        try{
          const j=JSON.parse(body||"{}");
          const r=await bridge.verifyPhoneAuth(String(j.id||""),String(j.code||""),String(j.password||""));
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
  const listenPort=Number(process.env.PORT||port||8787);
  bridge.httpServer=server;
  server.listen(listenPort,"0.0.0.0",()=>console.log("Telegram user bridge web listening on",listenPort));
  return server;
}

function connectHtml() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CarFlipCopilot — подключение</title>
<style>body{font-family:system-ui;margin:0;background:#111;color:#fff;text-align:center;padding:24px}main{max-width:520px;margin:auto}input,button{box-sizing:border-box;width:100%;padding:13px;margin:7px 0;border:0;border-radius:12px;font-size:16px}input{background:#222;color:#fff;border:1px solid #444}button{background:#fff;color:#111;font-weight:600}#qr{width:360px;max-width:90vw;background:#fff;padding:8px;border-radius:12px;display:none}.box{margin-top:18px;padding:16px;background:#1a1a1a;border-radius:16px}</style>
<main><h2>🔗 Подключение игры</h2><p id="status">Подключение Telegram</p>
<div class="box"><input id="phone" inputmode="tel" autocomplete="tel" placeholder="+79991234567"><button id="send">Получить код в Telegram</button></div>
<div class="box" id="codeBox" style="display:none"><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Код из Telegram"><input id="password" type="password" autocomplete="current-password" placeholder="Пароль 2FA, если включён"><button id="verify">Подтвердить вход</button></div>
<div class="box"><p>Или подключение через QR на другом устройстве:</p><button id="qrStart" type="button">Показать QR</button><img id="qr"><button id="open" type="button" style="display:none">Открыть Telegram</button></div></main>
<script>
const p=new URLSearchParams(location.search),ticket=p.get("ticket")||"";let id="",pollTimer=null;
async function post(url,data){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)});let j={};try{j=await r.json()}catch{};if(!r.ok&&!j.error)j.error="HTTP "+r.status;return j}
const statusEl=document.getElementById("status"),phoneEl=document.getElementById("phone"),sendEl=document.getElementById("send"),codeBoxEl=document.getElementById("codeBox"),codeEl=document.getElementById("code"),passwordEl=document.getElementById("password"),verifyEl=document.getElementById("verify"),qrEl=document.getElementById("qr"),openEl=document.getElementById("open");sendEl.onclick=async()=>{sendEl.disabled=true;statusEl.textContent="Отправляю код…";try{const j=await post("/connect/phone/start",{ticket,phone:phoneEl.value});if(j.error){statusEl.textContent="Ошибка: "+j.error;sendEl.disabled=false;return}id=j.id;codeBoxEl.style.display="block";statusEl.textContent="Код отправлен в Telegram. Введи его здесь.";codeEl.focus()}catch(e){statusEl.textContent="Ошибка соединения: "+e.message;sendEl.disabled=false}};
verifyEl.onclick=async()=>{verifyEl.disabled=true;statusEl.textContent="Проверяю вход…";try{const j=await post("/connect/phone/verify",{id,code:codeEl.value,password:passwordEl.value});if(j.error){statusEl.textContent="Ошибка: "+j.error;verifyEl.disabled=false;return}if(j.needsPassword){statusEl.textContent="Нужен пароль 2FA — введи его выше и снова нажми кнопку.";verifyEl.disabled=false;passwordEl.focus();return}if(j.connected){statusEl.textContent="✅ Telegram подключён. Вернись в бота и нажми «Проверить связь».";codeBoxEl.style.display="none"}}catch(e){statusEl.textContent="Ошибка соединения: "+e.message;verifyEl.disabled=false}};
async function qr(){const qrStartEl=document.getElementById("qrStart");qrStartEl.disabled=true;statusEl.textContent="Создаю QR для входа…";try{const j=await post("/connect/start",{ticket});if(j.error){statusEl.textContent="Ошибка: "+j.error;qrStartEl.disabled=false;return}if(j.connected){statusEl.textContent="✅ Telegram уже подключён.";return}id=j.id;const qid=j.id;async function poll(){try{const s=await(await fetch("/connect/status?id="+encodeURIComponent(qid)+"&t="+Date.now(),{cache:"no-store"})).json();if(s.connected){statusEl.textContent="✅ Telegram подключён. Вернись в бота и нажми «Проверить связь».";qrEl.style.display="none";openEl.style.display="none";qrStartEl.disabled=false;return}if(s.error){statusEl.textContent="Ошибка: "+s.error;qrStartEl.disabled=false;return}if(s.qr){qrEl.src="/connect/qr?id="+encodeURIComponent(qid)+"&t="+Date.now();qrEl.style.display="inline-block";openEl.style.display="inline-block";openEl.onclick=()=>{if(s.qr)location.href=s.qr}}pollTimer=setTimeout(poll,1500)}catch(e){statusEl.textContent="Ошибка проверки: "+e.message;qrStartEl.disabled=false}}poll()}catch(e){statusEl.textContent="Ошибка соединения: "+e.message;qrStartEl.disabled=false}}document.getElementById("qrStart").onclick=qr;
</script>`;
}

module.exports={TelegramUserBridge,createConnectServer,parseGameText};
