const { createWorker } = require("tesseract.js");

let workerPromise;
async function getWorker(){ if(!workerPromise) workerPromise=createWorker("rus+eng"); return workerPromise; }
function n(s){if(s==null)return null;const x=String(s).replace(/\s/g,"").replace(/,/g,".").replace(/[^0-9.]/g,"");const v=Number(x);return Number.isFinite(v)?v:null;}
function first(t,re){const m=String(t||"").match(re);return m?n(m[1]):null;}
function parseState(text){
 const raw=String(text||"").replace(/\u00a0/g," ").trim();
 const money=[...raw.matchAll(/([0-9][0-9\s]{3,})\s*(?:₽|руб|р\.?)/gi)].map(m=>n(m[1])).filter(Number.isFinite);
 const balance=first(raw,/(?:баланс|счет|сч[её]т)[^0-9]{0,30}([0-9][0-9\s.,]{2,})/i) ?? (money[0]??null);
 const price=first(raw,/(?:цена|стоимость|купить|продавец|продаж)[^0-9]{0,35}([0-9][0-9\s.,]{3,})/i) ?? (money.length?money[money.length-1]:null);
 const mileage=first(raw,/([0-9][0-9\s.,]{2,})\s*(?:км|km)/i);
 const hp=first(raw,/([0-9]{2,4})\s*(?:л\.?\s*с\.?|лс|hp)/i);
 const owners=first(raw,/([0-9]{1,2})\s*(?:владельц|владел|owners?)/i);
 const garage=(raw.match(/(?:гараж)[^0-9]{0,15}([0-9]{1,2}\s*\/\s*[0-9]{1,2})/i)||[])[1]||null;
 const lines=raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
 const car=lines.find(x=>/(audi|bmw|mercedes|toyota|lexus|jaguar|dodge|gac|volkswagen|volvo|porsche|nissan|honda|kia|hyundai|skoda|ford|chevrolet|cadillac|land rover|range rover|infiniti|mazda|subaru|mitsubishi|лада|ваз)/i.test(x))||null;
 return {balance,garage,vehicle:car?{name:car,price,hp,mileage,owners}:null,money_values:money.slice(0,20),raw_text:raw.slice(0,12000)};
}
function decide(s){
 const t=s.raw_text.toLowerCase(),v=s.vehicle||{};
 if(!t)return {action:"ПРИШЛИ ДРУГОЙ СКРИНШОТ",title:"Экран не прочитан",reason:"Локальный OCR не нашёл читаемого текста.",confidence:5};
 if(/предложение|покупатель|готов купить|предлагает/.test(t))return {action:"ПРОВЕРЬ ПРЕДЛОЖЕНИЕ ПОКУПАТЕЛЯ",title:"Есть предложение",reason:"Сначала сравни сумму с полной себестоимостью сделки; не принимай убыточное предложение вслепую.",confidence:72};
 if(/купить|покупка/.test(t)&&v.price!=null&&s.balance!=null&&v.price>s.balance)return {action:"НЕ ПОКУПАЙ",title:"Не хватает баланса",reason:"Распознанная цена выше доступного баланса.",confidence:88};
 if(/купить|покупка/.test(t))return {action:"ПРОВЕРЬ АВТО ПЕРЕД ПОКУПКОЙ",title:"Найдена покупка",reason:"Проверь состояние, пробег, владельцев и расходы перед покупкой.",confidence:68};
 if(/аукцион.*(номер|госномер)|номер.*аукцион|ставка/.test(t))return {action:"ПРОВЕРЬ СТАВКУ И КОМИССИЮ",title:"Аукцион номера",reason:"В игре аукцион относится к номерам, а не к автомобилям. Проверь итоговую стоимость и возможную перепродажу.",confidence:82};
 return {action:"ПРИШЛИ СКРИНШОТ С ТЕКУЩЕЙ СДЕЛКОЙ",title:"Нужно больше данных",reason:"OCR прочитал экран, но не нашёл однозначного действия.",confidence:35};
}
async function analyzeImage(input){const w=await getWorker();const r=await w.recognize(input);const state=parseState(r?.data?.text||"");return {...state,decision:decide(state),engine:"Tesseract.js local OCR",paid_api:false};}
module.exports={analyzeImage,parseState,decide};