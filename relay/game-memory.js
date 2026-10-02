const { Client } = require("pg");
const crypto=require("crypto");
let dbPromise=null;

function key(v){
  return crypto.createHash("sha256").update(String(v||"").slice(0,12000)).digest("hex");
}
function safeState(state){
  if(!state||typeof state!=="object") return {};
  const allow=["balance","garage","plate","vehicle","price","mileage","hp","owners","contexts","money_values","raw_message","raw_text","buttons","screen_class","received_at"];
  const out={};
  for(const k of allow) if(state[k]!==undefined) out[k]=state[k];
  return out;
}
async function db(){
  if(!process.env.DATABASE_URL)return null;
  if(!dbPromise){
    dbPromise=(async()=>{
      const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
      await c.connect();
      await c.query("CREATE TABLE IF NOT EXISTS game_memory_screens (id bigserial PRIMARY KEY,chat_id text NOT NULL,screen_key text NOT NULL,screen_class text,screen_text text NOT NULL,buttons jsonb NOT NULL,state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
      await c.query("CREATE INDEX IF NOT EXISTS game_memory_screens_chat_idx ON game_memory_screens(chat_id,created_at DESC)");
      await c.query("CREATE TABLE IF NOT EXISTS game_memory_actions (id bigserial PRIMARY KEY,chat_id text NOT NULL,before_screen_key text,before_text text NOT NULL,button text NOT NULL,before_state jsonb NOT NULL,after_screen_key text,after_text text,after_state jsonb,changed boolean,created_at timestamptz NOT NULL DEFAULT now())");
      await c.query("CREATE INDEX IF NOT EXISTS game_memory_actions_chat_idx ON game_memory_actions(chat_id,created_at DESC)");
      return c;
    })().catch(e=>{console.log("GAME MEMORY DB INIT ERROR:",e.message);dbPromise=null;return null;});
  }
  return dbPromise;
}
async function recordScreen(chat,state){
  const c=await db(); if(!c||chat==null)return;
  const text=String(state?.raw_message||state?.raw_text||"").slice(0,12000);
  if(!text)return;
  try{
    await c.query("INSERT INTO game_memory_screens(chat_id,screen_key,screen_class,screen_text,buttons,state) VALUES($1,$2,$3,$4,$5,$6)",[
      String(chat),key(text+"|"+JSON.stringify(state?.buttons||[])),String(state?.screen_class||"other"),text,
      JSON.stringify(Array.isArray(state?.buttons)?state.buttons:[]),JSON.stringify(safeState(state))
    ]);
  }catch(e){console.log("GAME MEMORY SCREEN ERROR:",e.message);}
}
async function recordAction(chat,beforeState,button,afterState){
  const c=await db(); if(!c||chat==null)return;
  const beforeText=String(beforeState?.raw_message||beforeState?.raw_text||"").slice(0,12000);
  const afterText=String(afterState?.raw_message||afterState?.raw_text||"").slice(0,12000);
  if(!beforeText)return;
  try{
    await c.query("INSERT INTO game_memory_actions(chat_id,before_screen_key,before_text,button,before_state,after_screen_key,after_text,after_state,changed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[
      String(chat),key(beforeText+"|"+JSON.stringify(beforeState?.buttons||[])),beforeText,String(button||""),
      JSON.stringify(safeState(beforeState)),afterText?key(afterText+"|"+JSON.stringify(afterState?.buttons||[])):null,
      afterText||null,afterText?JSON.stringify(safeState(afterState)):null,
      !!afterText && key(beforeText+"|"+JSON.stringify(beforeState?.buttons||[]))!==key(afterText+"|"+JSON.stringify(afterState?.buttons||[]))
    ]);
  }catch(e){console.log("GAME MEMORY ACTION ERROR:",e.message);}
}
async function recent(chat,limit=20){
  const c=await db(); if(!c||chat==null)return [];
  try{
    const r=await c.query("SELECT id,before_text,button,after_text,changed,created_at FROM game_memory_actions WHERE chat_id=$1 ORDER BY id DESC LIMIT $2",[String(chat),Math.max(1,Math.min(100,Number(limit)||20))]);
    return r.rows;
  }catch(e){return [];}
}
module.exports={recordScreen,recordAction,recent};
