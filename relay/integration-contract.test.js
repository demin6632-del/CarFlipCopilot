const fs = require("fs");
const assert = require("assert");

function read(path){ return fs.readFileSync(path,"utf8"); }
const telegram = read("relay/telegram-bot.js");
const bridge = read("relay/user-session-bridge.js");
const server = read("relay/server.js");

assert(bridge.includes("new NewMessage({})"), "GramJS NewMessage handler missing");
assert(bridge.includes("new EditedMessage({})"), "GramJS EditedMessage handler missing");
assert(bridge.includes("await this.handleGameMessage(msg);"), "Game message pipeline is not attached");
assert(bridge.includes("this.attachedClient === this.client"), "GramJS attachment must be idempotent");
assert(bridge.includes("this.attachedClient = this.client;"), "GramJS attachment state must be recorded");

assert(bridge.includes('this.relayUrl+"/bridge/state"'), "Bridge state publish endpoint missing");
assert(server.includes('req.url==="/bridge/state" && req.method==="POST"'), "Relay state ingestion endpoint missing");
assert(server.includes('if(req.url==="/state")return json(res,200,latest||{})'), "Relay state endpoint missing");
assert(server.indexOf('if(!auth(req))return json(res,401,{error:"unauthorized"});') < server.indexOf('if(req.url==="/state")return json(res,200,latest||{})'), "Relay state endpoint must stay behind auth");
assert(server.includes('if(req.url!=="/ws"||!auth(req))'), "WebSocket bridge must require relay auth");

assert(bridge.includes("process.env.DATABASE_URL"), "PostgreSQL configuration missing");
assert(bridge.includes('"telegram_session"'), "Telegram session persistence key missing");
assert(bridge.includes('"telegram_binding"'), "Telegram binding persistence key missing");

assert(telegram.includes("userBridge.clickGameButton(label,ref.messageId)"), "Game click is not bound to source message");
assert(telegram.includes("secret_token:WEBHOOK_SECRET"), "Telegram webhook secret is not configured");
assert(telegram.includes("createConnectServer(userBridge,BRIDGE_PORT,{webhookSecret:WEBHOOK_SECRET})"), "Webhook secret is not passed to HTTP server");
assert(bridge.includes("x-telegram-bot-api-secret-token"), "Telegram webhook secret validation missing");
assert(telegram.includes("waitForGameUpdate(ref.messageId"), "Callback update wait is missing");
assert(telegram.includes("waitForGameUpdate(latest.message_id"), "Normal game update wait is missing");
assert(telegram.includes("gameActionChats.add(String(chat));"), "Game action lock missing");
assert(telegram.includes("backgroundCallbackWait"), "Slow callback lock protection missing");
assert(telegram.includes("backgroundGameWait"), "Slow game lock protection missing");
assert(telegram.includes("waitForGameUpdate(latest.message_id,latest.text||\"\",latest.buttons||[],1200);"), "Game action wait must stay at 1200ms");
assert(telegram.includes("setTimeout(()=>resolve(null),700)"), "Game media wait must stay at 700ms");
assert(telegram.includes("waitForGameUpdate(latest.message_id,latest.text||\"\",latest.buttons||[],8000);"), "Slow game fallback wait must stay at 8000ms");
assert(bridge.includes("for (let attempt=0; attempt<6; attempt++)"), "Bridge fallback polling must stay bounded to 6 attempts");
assert(bridge.includes("await new Promise(r=>setTimeout(r,250));"), "Bridge fallback polling interval must stay at 250ms");
assert(bridge.includes('if(res.statusCode>=200 && res.statusCode<300) return resolve();'), "Relay HTTP failures must reject state publication");

console.log("Stage 6 integration contract: PASS");
