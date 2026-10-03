const crypto = require("crypto");

function normalizeScreenText(value){
  return String(value || "")
    .replace(/\u00a0/g," ")
    .replace(/\r/g,"\n")
    .replace(/[ \t]+/g," ")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function normalizeButtons(buttons){
  return [...new Set((Array.isArray(buttons)?buttons:[])
    .map(x=>String(x||"").trim())
    .filter(Boolean))];
}

function screenFingerprint(text,buttons=[]){
  const payload=normalizeScreenText(text).slice(0,12000)+"\n--BUTTONS--\n"+normalizeButtons(buttons).join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function isDuplicateScreen(previous,current,windowMs=15000){
  if(!previous || !current) return false;
  return previous.fingerprint===current.fingerprint &&
    Number(current.receivedAt||0)-Number(previous.receivedAt||0)>=0 &&
    Number(current.receivedAt||0)-Number(previous.receivedAt||0)<=windowMs;
}

function classifyScreen(text){
  const t=normalizeScreenText(text).toLowerCase();
  if(!t) return "empty";
  if(/ошиб|error|не удалось|произошл/.test(t)) return "error";
  if(/подтверд|точно|подтверждени/.test(t)) return "confirmation";
  if(/аукцион|торги|ставка|госномер|гос номер/.test(t)) return "auction";
  if(/предложение|покупател|готов купить|по рукам/.test(t)) return "buyer";
  if(/продать|продажа|объявлен|продлить/.test(t)) return "sale";
  if(/купить|покупка|продавец/.test(t)) return "purchase";
  if(/ремонт|почин/.test(t)) return "repair";
  if(/тюнинг|улучш/.test(t)) return "tune";
  if(/контракт|заказ|работ/.test(t)) return "work";
  if(/гараж|автомобил|машин/.test(t)) return "garage";
  return "other";
}

function validateOcrState(state){
  const s=state||{};
  const warnings=[];
  const balance=Number(s.balance);
  const price=Number(s.price);

  if(s.balance!=null && (!Number.isFinite(balance)||balance<0||balance>9999999999))
    warnings.push("balance_invalid");
  if(s.price!=null && (!Number.isFinite(price)||price<0||price>9999999999))
    warnings.push("price_invalid");

  if(Number.isFinite(balance)&&Number.isFinite(price)&&price>balance*100)
    warnings.push("price_balance_anomaly");

  if(s.vehicle && !s.vehicle.name && [s.vehicle.price,s.vehicle.hp,s.vehicle.mileage,s.vehicle.owners].some(v=>v!=null))
    warnings.push("vehicle_without_name");

  return {
    valid:warnings.length===0,
    warnings,
    trust:warnings.length===0 ? 1 : Math.max(0,1-warnings.length*0.25)
  };
}

function chooseStableState(previous,current){
  const check=validateOcrState(current);
  if(check.valid || !previous) return {state:current,accepted:true,reason:null,check};
  return {
    state:previous,
    accepted:false,
    reason:"Ненадёжное OCR-изменение не принято в состояние игры.",
    check
  };
}

module.exports={
  normalizeScreenText,
  normalizeButtons,
  screenFingerprint,
  isDuplicateScreen,
  classifyScreen,
  validateOcrState,
  chooseStableState
};
