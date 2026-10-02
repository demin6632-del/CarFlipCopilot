const ACTION_RE = [
  ["buy", /(куп|покуп|приобр|взять)/i],
  ["renew", /(продл|обновить\s+объяв)/i],
  ["sell", /(прод(аж|ать)|сбыть|по\s*рукам|принять\s+предлож)/i],
  ["plate", /(номер|госномер|аукцион|ставк)/i],
  ["repair", /(ремонт|почин)/i],
  ["tune", /(тюнинг|улучш)/i],
  ["work", /(работ|контракт|заказ)/i],
  ["cancel", /(отмен|назад|выйти)/i]
];

const RENEWAL_COST = 1500;
const PLATE_REMOVAL_COST = 55000;
const PLATE_AUCTION_COMMISSION = 0.10;

function textOf(state) {
  return String(state?.raw_message || state?.raw_text || "");
}
function actionType(label) {
  const t = String(label || "");
  for (const [type, re] of ACTION_RE) if (re.test(t)) return type;
  return "other";
}
function numberValue(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function parseContract(text) {
  const t = String(text || "");
  const reward = /(?:награда|вознаграждение|бонус)[^0-9]{0,40}([0-9][0-9 .]*)/i.exec(t);
  const max = /(?:макс(?:имум)?|лимит|до)[^0-9]{0,30}([0-9][0-9 .]*)\s*(?:₽|руб)?/i.exec(t);
  const hp = /(?:не менее|от|>=?)\s*([0-9]{2,4})\s*(?:л\.?\s*с\.?|лс|hp)/i.exec(t);
  const country = /(?:страна|country)[^\n:]*[:]?\s*([A-Za-zА-Яа-яЁё-]{3,})/i.exec(t);
  if (!/контракт|заказ|производител|требован/i.test(t) && !reward && !max && !hp && !country) return null;
  return {
    reward: reward ? numberValue(reward[1]) : null,
    maxPrice: max ? numberValue(max[1]) : null,
    minHp: hp ? numberValue(hp[1]) : null,
    country: country ? country[1] : null,
    matched: true
  };
}
function riskFor(type, state, history = {}) {
  const t = textOf(state);
  let score = 25;
  const reasons = [];
  if (["buy","sell","plate"].includes(type)) score += 20;
  if (type === "buy") {
    if (numberValue(state?.price) != null) score += 10;
    else { score += 25; reasons.push("цена не подтверждена"); }
    if (!state?.vehicle?.name) { score += 15; reasons.push("автомобиль не подтверждён"); }
  }
  if (type === "sell") {
    if (/предлож|покупател|по\s*рукам/i.test(t)) score += 10;
    else { score += 15; reasons.push("предложение покупателя не подтверждено"); }
  }
  if (type === "plate") {
    if (/аукцион|ставк|комисси/i.test(t)) score += 10;
    else reasons.push("условия номера не подтверждены");
  }
  if (type === "renew") {
    score = 30;
    reasons.push("продление увеличивает себестоимость на 1 500 ₽");
  }
  if (history?.sameActionCount > 2) {
    score += 15;
    reasons.push("это действие уже повторялось несколько раз");
  }
  return { score: Math.min(100, score), reasons };
}
function contractFit(contract, state) {
  if (!contract) return null;
  const hp = numberValue(state?.vehicle?.hp ?? state?.hp);
  const price = numberValue(state?.price ?? state?.offer ?? state?.saleOffer);
  const checks = [];
  if (contract.minHp != null) checks.push({name:"мощность",ok:hp!=null ? hp >= contract.minHp : null,actual:hp,required:contract.minHp});
  if (contract.maxPrice != null) checks.push({name:"цена",ok:price!=null ? price <= contract.maxPrice : null,actual:price,required:contract.maxPrice});
  return {
    checks,
    known: checks.filter(x=>x.ok!==null).length,
    passed: checks.filter(x=>x.ok===true).length,
    failed: checks.filter(x=>x.ok===false).length,
    complete: checks.length>0 && checks.every(x=>x.ok!==null),
    satisfied: checks.length>0 && checks.every(x=>x.ok===true)
  };
}
function scenarioFor(type, state, economics = null) {
  if (type === "renew") {
    const nextCost = economics?.cost != null ? economics.cost + RENEWAL_COST : null;
    return nextCost != null
      ? "Продление: +1 500 ₽ к себестоимости; новая себестоимость ≈ " + Math.round(nextCost).toLocaleString("ru-RU") + " ₽. Цена нового предложения не подтверждена."
      : "Продление: +1 500 ₽ к себестоимости; новое предложение пока не подтверждено.";
  }
  if (type === "sell") {
    if (!economics) return "Продажа: сначала нужна подтверждённая цена предложения и зафиксированная себестоимость.";
    const p = Math.round(economics.profitAfterFee).toLocaleString("ru-RU");
    return "Продажа: после сделки ожидаемый результат ≈ " + p + " ₽ до неизвестных комиссий продажи.";
  }
  if (type === "buy") {
    const price = numberValue(state?.price);
    const balance = numberValue(state?.balance);
    if (price != null && balance != null) {
      const after = balance - price;
      return "Покупка: −" + Math.round(price).toLocaleString("ru-RU") + " ₽; остаток ≈ " + Math.round(after).toLocaleString("ru-RU") + " ₽.";
    }
    return "Покупка: деньги уйдут сразу; прибыль не фиксируется до будущей продажи.";
  }
  if (type === "plate") {
    return "Номер: если это продажа через аукцион, комиссия учитывается отдельно (10%); при снятии номера с автомобиля дополнительно 55 000 ₽.";
  }
  if (type === "repair" || type === "tune") return "Расход: оплаченная сумма увеличит себестоимость текущего автомобиля.";
  if (type === "work") return "Контракт/работа: действие может дать доход или открыть условие заказа; сначала проверяются требования и награда.";
  if (type === "cancel") return "Отмена: сделка или действие не подтверждается; прямого расхода по текущему экрану не видно.";
  return "Последствие не подтверждено текущим экраном.";
}
function buildStrategy(state, ranked = [], economy = null) {
  const screenText = textOf(state);
  const hasContext = !!(
    state?.contexts?.buyerContext || state?.contexts?.explicitPlateAuction ||
    state?.contexts?.purchaseContext || state?.contexts?.dealContext ||
    /(?:купить|покупка|продать|продажа|покупател|продавец|аукцион|ставк|номер|ремонт|почин|тюнинг|улучш|работ|контракт|заказ|продл|объявлен)/i.test(screenText)
  );
  const buttons = Array.isArray(state?.buttons) ? [...new Set(state.buttons.map(String).filter(Boolean))] : [];
  const history = Array.isArray(economy?.transactions) ? economy.transactions : [];
  const sameActionCount = new Map();
  for (const row of history) {
    const type = actionType(row.action);
    sameActionCount.set(type, (sameActionCount.get(type) || 0) + 1);
  }

  const contract = parseContract(screenText);
  const currentVehicle = economy?.vehicles?.find(v => v.status === "active");
  const cost = currentVehicle?.full_cost != null ? numberValue(currentVehicle.full_cost) : null;
  const offer = numberValue(state?.offer ?? state?.saleOffer ?? state?.buyerOffer);
  const balance = numberValue(state?.balance);
  const renewalCount = sameActionCount.get("renew") || 0;
  const contractFitResult = contractFit(contract, state);

  const economics = cost != null && offer != null ? {
    cost, offer,
    renewalCount,
    renewalCost: renewalCount * RENEWAL_COST,
    fee: null,
    delta: offer - cost,
    profitBeforeFee: offer - cost,
    profitAfterFee: offer - cost,
    feeKnown: false
  } : null;

  const alternatives = buttons.map(label => {
    const type = actionType(label);
    const risk = riskFor(type, state, { sameActionCount: sameActionCount.get(type) || 0 });
    const rank = Array.isArray(ranked) ? ranked.find(x => x.label === label) : null;
    const scenario = scenarioFor(type, {...state,balance}, economics);
    const contractBlocked = type === "work" && contractFitResult?.complete && !contractFitResult.satisfied;
    return {
      label, type, score: rank?.percent ?? null, risk: contractBlocked ? Math.min(100,risk.score+25) : risk.score,
      reasons: contractBlocked ? [...risk.reasons,"условия контракта не выполнены"] : risk.reasons,
      scenario,
      contractBlocked
    };
  });

  const explicit = /(?:нажми|выбери|нужно\s+нажать|следует\s+нажать)\s+[«"“]?([^»"”\n]+)[»"”]?/i.exec(screenText);
  const evidence = explicit ? buttons.find(x => x.toLowerCase() === explicit[1].trim().toLowerCase()) : null;
  const actionable = !!(evidence || hasContext);

  const warnings = [];
  if (!buttons.length) warnings.push("кнопки текущего экрана не распознаны");
  if (economics && economics.delta < 0) warnings.push("предложение ниже зафиксированной себестоимости");
  if (contractFitResult?.failed) warnings.push("часть условий контракта не выполнена");
  if (contractFitResult && !contractFitResult.complete) warnings.push("часть условий контракта пока не подтверждена");

  return {
    actionEvidence: evidence || null,
    actionable,
    alternatives,
    contract,
    contractFit: contractFitResult,
    economics,
    historyCount: history.length,
    historyByAction: Object.fromEntries([...sameActionCount.entries()]),
    renewalCount,
    warnings
  };
}
module.exports = { buildStrategy, actionType, parseContract, riskFor, contractFit, scenarioFor, numberValue };