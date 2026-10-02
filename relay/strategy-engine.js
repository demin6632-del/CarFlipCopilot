const ACTION_RE = [
  ["buy", /(куп|покуп|приобр|взять)/i],
  ["sell", /(прод|продаж|сбыть|по\\s*рукам|принять\\s+предлож)/i],
  ["renew", /(продл|обновить\\s+объяв)/i],
  ["plate", /(номер|госномер|аукцион|ставк)/i],
  ["repair", /(ремонт|почин)/i],
  ["tune", /(тюнинг|улучш)/i],
  ["work", /(работ|контракт|заказ)/i],
  ["cancel", /(отмен|назад|выйти)/i]
];

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
  const max = /(?:макс(?:имум)?|до)[^0-9]{0,30}([0-9][0-9 .]*)\\s*(?:₽|руб)/i.exec(t);
  const hp = /(?:не менее|от|>=?)\\s*([0-9]{2,4})\\s*(?:л\\.?\\s*с\\.?|hp)/i.exec(t);
  const country = /(?:страна|country)[^\\n:]*[:]?\\s*([A-Za-zА-Яа-яЁё-]{3,})/i.exec(t);
  if (!/контракт|заказ|производител|требован/i.test(t) && !reward && !max && !hp) return null;
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
    if (/предлож|покупател|по\\s*рукам/i.test(t)) score += 10;
    else { score += 15; reasons.push("предложение покупателя не подтверждено"); }
  }
  if (type === "plate") {
    if (/аукцион|ставк|комисси/i.test(t)) score += 10;
    else reasons.push("условия номера не подтверждены");
  }
  if (type === "renew") {
    score = 30;
    reasons.push("продление увеличивает себестоимость");
  }
  if (history?.sameActionCount > 2) {
    score += 15;
    reasons.push("это действие уже повторялось несколько раз");
  }
  return { score: Math.min(100, score), reasons };
}

function buildStrategy(state, ranked = [], economy = null) {
  const buttons = Array.isArray(state?.buttons) ? state.buttons.map(String) : [];
  const history = Array.isArray(economy?.transactions) ? economy.transactions : [];
  const sameActionCount = new Map();
  for (const row of history) {
    const type = actionType(row.action);
    sameActionCount.set(type, (sameActionCount.get(type) || 0) + 1);
  }

  const contract = parseContract(textOf(state));
  const alternatives = buttons.map(label => {
    const type = actionType(label);
    const risk = riskFor(type, state, { sameActionCount: sameActionCount.get(type) || 0 });
    const rank = Array.isArray(ranked) ? ranked.find(x => x.label === label) : null;
    return {
      label,
      type,
      score: rank?.percent ?? null,
      risk: risk.score,
      reasons: risk.reasons
    };
  });

  const currentVehicle = economy?.vehicles?.find(v => v.status === "active");
  const cost = currentVehicle?.full_cost ?? null;
  const offer = numberValue(state?.offer ?? state?.saleOffer);
  const economics = cost != null && offer != null ? {
    cost,
    offer,
    delta: offer - cost,
    profitBeforeFee: offer - cost
  } : null;

  const explicit = /(?:нажми|выбери|нужно\\s+нажать|следует\\s+нажать)\\s+[«"“]?([^»"”\\n]+)[»"”]?/i.exec(textOf(state));
  const evidence = explicit ? buttons.find(x => x.toLowerCase() === explicit[1].trim().toLowerCase()) : null;

  return {
    actionEvidence: evidence || null,
    alternatives,
    contract,
    economics,
    historyCount: history.length,
    warnings: [
      ...(!buttons.length ? ["кнопки текущего экрана не распознаны"] : []),
      ...(economics && economics.delta < 0 ? ["предложение ниже зафиксированной себестоимости"] : [])
    ]
  };
}

module.exports = { buildStrategy, actionType, parseContract, riskFor };
