const { Client } = require("pg");

const LOCK_KEY = 742913; // Stable advisory-lock key for the single Telegram Bot API consumer.
let client = null;
let held = false;

async function acquireTelegramPollLock(){
  if(held)return true;
  const url=process.env.DATABASE_URL;
  if(!url){
    console.log("TELEGRAM POLL LOCK: DATABASE_URL missing; using single-instance fallback");
    return true;
  }
  try{
    const c=new Client({
      connectionString:url,
      ssl:{rejectUnauthorized:false},
      connectionTimeoutMillis:5000,
      query_timeout:5000,
      statement_timeout:5000
    });
    await c.connect();
    const r=await c.query("SELECT pg_try_advisory_lock($1) AS locked",[LOCK_KEY]);
    if(!r.rows[0]?.locked){
      await c.end().catch(()=>{});
      console.log("TELEGRAM POLL LOCK: another instance is active; this instance will stay passive");
      return false;
    }
    client=c;
    held=true;
    console.log("TELEGRAM POLL LOCK: acquired");
    return true;
  }catch(e){
    console.log("TELEGRAM POLL LOCK ERROR:",e.message);
    try{if(client)await client.end();}catch{}
    client=null;
    held=false;
    // Fail closed: never allow two getUpdates consumers because that breaks delivery.
    return false;
  }
}

async function releaseTelegramPollLock(){
  if(!client)return;
  const c=client;
  client=null;
  held=false;
  try{await c.query("SELECT pg_advisory_unlock($1)",[LOCK_KEY]);}catch{}
  try{await c.end();}catch{}
  console.log("TELEGRAM POLL LOCK: released");
}

module.exports={acquireTelegramPollLock,releaseTelegramPollLock};
