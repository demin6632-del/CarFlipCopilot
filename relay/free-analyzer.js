const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

let workerPromise;\nlet analysisQueue = Promise.resolve();
async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("rus+eng").catch(err => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[|]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n")
    .trim();
}

function normalizeOcrDigits(value) {
  return String(value || "")
    .replace(/[ОоО]/g, "0")
    .replace(/[Оо]/g, "0")
    .replace(/[Зз]/g, "3")
    .replace(/[Бб]/g, "6")
    .replace(/[IІl]/g, "1");
}

function moneyNumber(value) {
  if (value == null) return null;
  const s = normalizeOcrDigits(value);
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

function numberCandidates(text) {
  const out = [];
  const re = /(?<![A-Za-zА-Яа-я])([0-9][0-9 .,_]{1,})(?![A-Za-zА-Яа-я])/g;
  for (const m of String(text || "").matchAll(re)) {
    const raw = m[1].trim();
    const value = moneyNumber(raw);
    if (value != null) out.push({ value, raw, index: m.index || 0 });
  }
  return out;
}

function lineInfo(text) {
  return String(text || "")
    .split(/\n+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map((text, index) => ({ text, index }));
}

function findLabeledNumber(lines, labels, options = {}) {
  const pattern = new RegExp(labels.join("|"), "i");
  const maxDistance = options.maxDistance ?? 2;
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const excluded = options.excluded || [];
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i].text)) continue;

    for (let j = i; j <= Math.min(lines.length - 1, i + maxDistance); j++) {
      const distance = j - i;
      for (const c of numberCandidates(lines[j].text)) {
        if (c.value < min || c.value > max) continue;
        if (excluded.some(x => x === c.value)) continue;
        let score = 100 - distance * 18;
        if (j === i) score += 30;
        if (/₽|руб|рубл/i.test(lines[j].text)) score += 12;
        if (/[., ]/.test(c.raw)) score += 4;
        candidates.push({ ...c, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value ?? null;
}

function findUnitNumber(lines, unit, options = {}) {
  const re = new RegExp("([0-9][0-9 .,_]{0,10})\\s*" + unit, "i");
  const candidates = [];
  for (const line of lines) {
    const m = line.text.match(re);
    if (!m) continue;
    const value = moneyNumber(m[1]);
    if (value == null) continue;
    if (value < (options.min ?? 0) || value > (options.max ?? Number.MAX_SAFE_INTEGER)) continue;
    candidates.push(value);
  }
  return candidates[0] ?? null;
}

function findGarage(lines) {
  for (const line of lines) {
    if (!/гараж/i.test(line.text)) continue;
    const m = line.text.match(/([0-9]{1,2})\s*[/\\|]\s*([0-9]{1,2})/);
    if (m) return m[1] + "/" + m[2];
    const nums = numberCandidates(line.text).filter(x => x.value <= 99);
    if (nums.length >= 2) return nums[0].value + "/" + nums[1].value;
  }
  return null;
}

function findPlate(text) {
  const normalized = String(text || "").toUpperCase().replace(/Ё/g, "Е");
  const patterns = [
    /\b[A-ZА-Я]\s*\d{3}\s*[A-ZА-Я]{2}\s*\d{2,3}\b/,
    /\b[A-ZА-Я0-9]{1,6}\s+\d{2,3}\b/
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

function findVehicle(lines) {
  const brands = /audi|bmw|mercedes|benz|toyota|lexus|jaguar|dodge|gac|volkswagen|volvo|porsche|nissan|honda|kia|hyundai|skoda|ford|chevrolet|cadillac|land rover|range rover|infiniti|mazda|subaru|mitsubishi|лада|ваз|генезис|genesis|chery|geely|haval|exeed|omoda|jetour|li auto|zeekr|tank/i;
  const classWords = /класс|премиум|суперкар|кроссовер|седан|универсал|внедорожник|автомобиль/i;
  const candidates = lines.filter(x => brands.test(x.text));
  candidates.sort((a, b) => {
    const sa = (brands.test(a.text) ? 3 : 0) + (classWords.test(a.text) ? 1 : 0);
    const sb = (brands.test(b.text) ? 3 : 0) + (classWords.test(b.text) ? 1 : 0);
    return sb - sa;
  });
  return candidates[0]?.text || null;
}

function parseState(text) {
  const raw = normalizeText(text);
  const lines = lineInfo(raw);
  const balance = findLabeledNumber(lines, ["баланс", "сч[её]т", "денег", "наличн"], {
    min: 1000,
    max: 999999999,
    maxDistance: 1
  });

  const price = findLabeledNumber(lines, ["цена", "стоимость", "купить", "продать", "продажа", "продавец", "предложение", "ставка"], {
    min: 10000,
    max: 999999999,
    maxDistance: 1,
    excluded: balance != null ? [balance] : []
  });

  const mileage = findUnitNumber(lines, "(?:км|km)", { min: 100, max: 2000000 });
  const hp = findUnitNumber(lines, "(?:л\\.?\\s*с\\.?|лс|hp)", { min: 30, max: 3000 });
  const owners = findLabeledNumber(lines, ["владельц", "владел", "owners?"], {
    min: 1,
    max: 20,
    maxDistance: 1
  });
  const garage = findGarage(lines);
  const plate = findPlate(raw);
  const vehicleName = findVehicle(lines);

  const explicitPlateAuction =
    /(?:аукцион|торги).{0,80}(?:номер|госномер|гос\.?\s*номер|регистрац)/is.test(raw) ||
    /(?:номер|госномер|гос\.?\s*номер|регистрац).{0,80}(?:аукцион|торги)/is.test(raw) ||
    /(?:ставка|лот).{0,60}(?:номер|госномер)/is.test(raw) ||
    /(?:номер|госномер).{0,60}(?:ставка|лот)/is.test(raw) ||
    /sell_plate|склад(?:е|а).{0,40}ном/i.test(raw);

  const buyerContext = /предложение.{0,50}(?:покупател|купить|забрать)|(?:покупател|готов\s+купить|осмотр|торг).{0,80}(?:₽|руб|цена|предлага)/is.test(raw);
  const purchaseContext = /купить|покупка|покупател|продать|продажа|продавец|гараж|автомобил|машин/i.test(raw);

  return {
    balance,
    garage,
    plate,
    vehicle: vehicleName ? { name: vehicleName, price, hp, mileage, owners } : null,
    price,
    mileage,
    hp,
    owners,
    contexts: { explicitPlateAuction, buyerContext, purchaseContext },
    money_values: numberCandidates(raw).map(x => x.value).filter(x => x >= 1000).slice(0, 50),
    raw_text: raw.slice(0, 16000)
  };
}

function confidenceFor(state, ocr) {
  let score = Math.max(0, Number(ocr) || 0) * 0.65;
  if (state.balance != null) score += 12;
  if (state.garage != null) score += 5;
  if (state.vehicle?.name) score += 10;
  if (state.price != null) score += 8;
  if (state.mileage != null) score += 5;
  if (state.hp != null) score += 4;
  if (state.owners != null) score += 4;
  if (state.plate) score += 4;
  if (state.contexts?.explicitPlateAuction) score += 8;
  return Math.max(5, Math.min(94, Math.round(score)));
}

function decide(state, ocr = 0) {
  const t = state.raw_text.toLowerCase();
  if (!t) {
    return {
      action: "ПРИШЛИ ДРУГОЙ СКРИНШОТ",
      title: "Экран не прочитан",
      reason: "Локальный OCR не нашёл читаемого текста.",
      confidence: 5
    };
  }

  if (state.contexts?.buyerContext) {
    return {
      action: "ПРОВЕРЬ ПРЕДЛОЖЕНИЕ ПОКУПАТЕЛЯ",
      title: "Найдено предложение покупателя",
      reason: "Сначала сравни предложение с полной себестоимостью машины и ожидаемой прибылью.",
      confidence: confidenceFor(state, ocr)
    };
  }

  if (state.contexts?.explicitPlateAuction) {
    return {
      action: "ПРОВЕРЬ СТАВКУ НА НОМЕР",
      title: "Аукцион номера",
      reason: "В этой игре аукцион относится к госномерам. Проверь ставку, комиссию и возможную цену перепродажи.",
      confidence: confidenceFor(state, ocr)
    };
  }

  if (/купить|покупка/.test(t) && state.price != null && state.balance != null && state.price > state.balance) {
    return {
      action: "НЕ ПОКУПАЙ",
      title: "Цена выше баланса",
      reason: "Распознанная цена выше доступного баланса. Перед решением проверь цифры на экране.",
      confidence: confidenceFor(state, ocr)
    };
  }

  if (/купить|покупка/.test(t)) {
    return {
      action: "ПРОВЕРЬ АВТО ПЕРЕД ПОКУПКОЙ",
      title: "Найдена покупка",
      reason: "Проверь цену, состояние, пробег, владельцев и дополнительные расходы.",
      confidence: confidenceFor(state, ocr)
    };
  }

  return {
    action: "ПРИШЛИ СКРИНШОТ С ТЕКУЩЕЙ СДЕЛКОЙ",
    title: "Нужно больше данных",
    reason: "Текст распознан, но ситуацию нельзя определить надёжно.",
    confidence: Math.min(45, confidenceFor(state, ocr))
  };
}

async function preprocess(input, mode = "normal") {
  const base = Buffer.isBuffer(input) ? input : await sharp(input).png().toBuffer();
  let image = sharp(base).rotate().resize({ width: 2600, withoutEnlargement: false }).grayscale().normalize();
  if (mode === "sharp") image = image.sharpen({ sigma: 1.2 });
  if (mode === "threshold") image = image.sharpen({ sigma: 1.5 }).linear(1.25, -20);
  return image.png().toBuffer();
}

async function recognize(worker, image) {
  const result = await worker.recognize(image);
  return {
    text: result?.data?.text || "",
    confidence: Number(result?.data?.confidence) || 0
  };
}

async function analyzeImageQueued(input) {
  const previous = analysisQueue;
  let release;
  analysisQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await analyzeImageInternal(input);
  } finally {
    release();
  }
}

async function analyzeImageInternal(input) {
  const worker = await getWorker();
  const passes = [];
  const run = async mode => {
    try {
      passes.push(await recognize(worker, await preprocess(input, mode)));
    } catch (e) {
      console.log("OCR PASS ERROR", mode, e.message);
    }
  };

  // Fast path: one OCR pass first. Extra passes are used only when the first
  // result is weak or misses important game labels.
  await run("normal");
  let best = passes[0] || { text: "", confidence: 0 };
  const needsSecondPass =
    best.confidence < 62 ||
    !/баланс|гараж|цена|стоимость|покуп|продаж|аукцион|номер|пробег|л\.?\s*с\.?/i.test(best.text);
  if (needsSecondPass) {
    await run("sharp");
    best = passes.slice().sort((a, b) =>
      (Number(b.confidence || 0) + Math.min(25, b.text.length / 80)) -
      (Number(a.confidence || 0) + Math.min(25, a.text.length / 80))
    )[0] || best;
  }
  const needsThirdPass =
    !best.text.trim() ||
    best.confidence < 45 ||
    !/баланс|гараж|цена|стоимость|покуп|продаж|аукцион|номер/i.test(best.text);
  if (needsThirdPass) await run("threshold");

  best = passes.filter(x => x.text.trim()).sort((a, b) => {
    const score = x => Number(x.confidence || 0) + Math.min(25, x.text.length / 80);
    return score(b) - score(a);
  })[0] || { text: "", confidence: 0 };

  const state = parseState(best.text);
  const balanceLabelPresent = /баланс|сч[её]т|денег|наличн/i.test(best.text);
  const suspiciousBalance = balanceLabelPresent && (state.balance == null || state.balance < 10000);
  if (suspiciousBalance) state.balance = null;

  return {
    ...state,
    decision: decide(state, best.confidence),
    ocr_confidence: Math.round(best.confidence),
    engine: "Tesseract.js local OCR + adaptive multi-pass preprocessing",
    paid_api: false,
    warning: suspiciousBalance
      ? "Баланс распознан ненадёжно — бот не будет показывать предположительную сумму."
      : null
  };
}

function analyzeImage(input) {
  return analyzeImageQueued(input);
}

module.exports = { analyzeImage, parseState, decide };
