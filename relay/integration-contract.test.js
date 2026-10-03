const fs = require("fs");
const assert = require("assert");

function read(path){ return fs.readFileSync(path,"utf8"); }
const telegram = read("relay/telegram-bot.js");
const bridge = read("relay/user-session-bridge.js");
const server = read("relay/server.js");

assert(bridge.includes("new NewMessage({})"), "GramJS NewMessage handler missing");
assert(bridge.includes("new EditedMessage({})"), "GramJS EditedMessage handler missing");
assert(bridge.includes("await this.handleGameMessage(msg);"), "Game message pipeline is not attached");

assert(bridge.includes('this.relayUrl+"/bridge/state"'), "Bridge state publish endpoint missing");
assert(server.includes('req.url==="/bridge/state" && req.method==="POST"'), "Relay state ingestion endpoint missing");
assert(server.includes('if(req.url==="/state")return json(res,200,latest||{})'), "Relay state endpoint missing");

assert(bridge.includes("process.env.DATABASE_URL"), "PostgreSQL configuration missing");
assert(bridge.includes('"telegram_session"'), "Telegram session persistence key missing");
assert(bridge.includes('"telegram_binding"'), "Telegram binding persistence key missing");

assert(telegram.includes("userBridge.clickGameButton(label,ref.messageId)"), "Game click is not bound to source message");
assert(telegram.includes("waitForGameUpdate(ref.messageId"), "Callback update wait is missing");
assert(telegram.includes("waitForGameUpdate(latest.message_id"), "Normal game update wait is missing");
assert(telegram.includes("gameActionChats.add(String(chat));"), "Game action lock missing");
assert(telegram.includes("backgroundCallbackWait"), "Slow callback lock protection missing");
assert(telegram.includes("backgroundGameWait"), "Slow game lock protection missing");

console.log("Stage 6 integration contract: PASS");
