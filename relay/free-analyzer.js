const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

let workerPromise;
async function getWorker(){ if(!workerPromise) workerPromise=createWorker("rus+eng"); return workerPromise; }

function cleanText(s){ return String(s||"").replace(/\u00a0/g," ").replace(/[|]/g," ").replace(/[ ]{2,}/g," ").trim(); }
function moneyNumber(s){
  if(s==null)return null;
  const digits=String(s).replace(/[^0-9]/g,"");
  if(!digits)return null;
  const v=Number(digits);
  return Number.isSafeInteger(v)?v:null;
}
function firstMoney(text,re){const m=String(text||"").match(re);return m?moneyNumber(m[1]):null;}
function labeledMoney(raw,labels){
  const re=new RegExp("(?:^|\\n|\\r)\\s*(?:"+labels.join("|")+")[^0-9]{0,45}([0-9][0-9 .,_]{2,})","im");
  return firstMoney(raw,re);
}
function uniqueNumbers(text){
  return [...String(text||"").matchAll(/\b[0-9][0-9 .,_]{2,}\b/g)].map(m=>moneyNumber(m[0])).filter(Number.isFinite);
}

function parseState(text){
  const raw=cleanText(text);
  const balance=labeledMoney(raw,["баланс","сч[её]т","денег"]) ??
    firstMoney(raw,/(?:баланс|сч[её]т|денег)[^0-9]{0,45}([0-9][0-9 .,_]{2,})/i);
  const price=labeledMoney(raw,["цена","стоимость","купить","продать","продажа","продавец"]) ??
    firstMoney(raw,/(?:цена|стоимость|купить|продать|продажа|продавец)[^0-9]{0,50}([0-9][0-9 .,_]{3,})/i);
  const mileage=firstMoney(raw,/([0-9][0-9 .,_]{2,})\s*(?:км|km)\b/i);
  const hp=firstMoney(raw,/([0-9]{2,4})\s*(?:л\.?\s*с\.?|лс|hp)\b/i);
  const owners=firstMoney(raw,/([0-9]{1,2})\s*(?:владельц|владел|owners?)\b/i);
  const garage=(raw.match(/(?:гараж)[^0-9]{0,20}([0-9]{1,2}\s*\/\s*[0-9]{1,2})/i)||[])[1]||null;
  const plate=(raw.match(/\b[A-ZА-Я]\s*\d{3}\s*[A-ZА-Я]{2}\s*\d{2,3}\b/i)||[])[0]||
    (raw.match(/\b[A-ZА-Я0-9]{1,6}\s+\d{2,3}\b/i)||[])[0]||null;
  const lines=raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const carBrands=/audi|bmw|mercedes|toyota|lexus|jaguar|dodge|gac|volkswagen|volvo|porsche|nissan|honda|kia|hyundai|skoda|ford|chevrolet|cadillac|land rover|range rover|infiniti|mazda|subaru|mitsubishi|лада|ваз|генезис|genesis|chery|geely|haval|exeed|omoda|jetour/i;
  const car=lines.find(x=>carBrands.test(x))||null;
  const explicitPlateAuction=/аукцион.{0,50}(номер|госномер|регистрац)|(?:номер|госномер|регистрац).{0,50}аукцион|sell_plate|склад(?:е|а).{0,30}ном|ставка.{0,40}(номер|лот)/i.test(raw);
  const buyerContext=/предложение|покупатель|готов\s+(?:купить|забрать)|осмотр|торг|предлагает/i.test(raw);
  return {
    balance,garage,plate,
    vehicle:car?{name:car,price,hp,mileage,owners}:null,
    price,mileage,hp,owners,
    contexts:{explicitPlateAuction,buyerContext,purchaseContext:/купить|покупка|продать|продажа|выставить|гараж/i.test(raw)},
    money_values:uniqueNumbers(raw).slice(0,30),
    raw_text:raw.slice(0,16000)
  };
}

function confidenceFor(state,ocr){
  let score=Number.isFinite(ocr)?ocr:0;
  if(state.balance!=null)score+=12;if(state.garage!=null)score+=5;if(state.vehicle?.name)score+=10;
  if(state.price!=null)score+=8;if(state.mileage!=null)score+=4;if(state.hp!=null)score+=3;if(state.owners!=null)score+=3;
  if(state.contexts?.explicitPlateAuction)score+=8;
  return Math.max(5,Math.min(96,Math.round(score)));
}
function decide(s,ocr=0){
  const t=s.raw_text.toLowerCase();
  if(!t)return {action:"ПРИШЛИ ДРУГОЙ СКРИНШОТ",title:"Экран не прочитан",reason:"Локальный OCR не нашёл читаемого текста.",confidence:5};
  if(s.contexts?.buyerContext)return {action:"ПРОВЕРЬ ПРЕДЛОЖЕНИЕ ПОКУПАТЕЛЯ",title:"Найдено предложение покупателя",reason:"Сравни предложение с полной себестоимостью машины и ожидаемой прибылью.",confidence:confidenceFor(s,ocr)};
  if(s.contexts?.explicitPlateAuction)return {action:"ПРОВЕРЬ СТАВКУ НА НОМЕР",title:"Аукцион номера",reason:"В этой игре аукцион относится к госномерам. Проверь ставку, комиссию и возможную цену перепродажи.",confidence:confidenceFor(s,ocr)};
  if(/купить|покупка/.test(t)&&s.price!=null&&s.balance!=null&&s.price>s.balance)return {action:"НЕ ПОКУПАЙ",title:"Цена выше баланса",reason:"Распознанная цена выше доступного баланса. Сначала проверь цифры на экране.",confidence:confidenceFor(s,ocr)};
  if(/купить|покупка/.test(t))return {action:"ПРОВЕРЬ АВТО ПЕРЕД ПОКУПКОЙ",title:"Найдена покупка",reason:"Проверь цену, состояние, пробег, владельцев и дополнительные расходы.",confidence:confidenceFor(s,ocr)};
  return {action:"ПРИШЛИ СКРИНШОТ С ТЕКУЩЕЙ СДЕЛКОЙ",title:"Нужно больше данных",reason:"Текст распознан, но действие нельзя определить надёжно.",confidence:Math.min(45,confidenceFor(s,ocr))};
}

async function preprocess(input){
  const source=Buffer.isBuffer(input)?input:await sharp(input).png().toBuffer();
  return sharp(source).rotate().resize({width:2200,withoutEnlargement:false}).grayscale().normalize().sharpen().png().toBuffer();
}
async function recognizePass(worker,image){
  const r=await worker.recognize(image);
  return {text:r?.data?.text||"",confidence:Number(r?.data?.confidence)||0};
}
async function analyzeImage(input){
  const worker=await getWorker();
  let image=input; try{image=await preprocess(input);}catch(_){}
  const passes=[await recognizePass(worker,image)];
  try{passes.push(await recognizePass(worker,input));}catch(_){}
  const best=passes.filter(x=>x.text.trim()).sort((a,b)=>(b.confidence+Math.min(25,b.text.length/80))-(a.confidence+Math.min(25,a.text.length/80)))[0]||{text:"",confidence:0};
  const state=parseState(best.text);
  const suspicious=state.balance!=null&&state.balance<100000&&/баланс|сч[её]т|денег/i.test(best.text);
  if(suspicious)state.balance=null;
  return {...state,decision:decide(state,best.confidence),ocr_confidence:Math.round(best.confidence),engine:"Tesseract.js local OCR + preprocessing",paid_api:false,
    warning:suspicious?"Баланс распознан ненадёжно — бот специально не показывает ошибочную сумму.":null};
}
module.exports={analyzeImage,parseState,decide};