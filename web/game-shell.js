(() => {
  "use strict";
  const telegram = window.Telegram && window.Telegram.WebApp;
  if (!telegram || !telegram.initData) {
    document.body.style.cssText = "margin:0;background:#101216;color:#f5f5f5;font:16px Arial,sans-serif";
    const notice = document.createElement("main");
    notice.style.cssText = "max-width:520px;margin:15vh auto;padding:28px;line-height:1.5";
    const title = document.createElement("h1");
    title.textContent = "AUTOFLIP";
    const message = document.createElement("p");
    message.textContent = "Игровая страница открывается только внутри Telegram. Вернись в чат с ботом и нажми кнопку открытия Mini App.";
    const link = document.createElement("a");
    link.href = "https://t.me/autoflip_test_bot";
    link.textContent = "ОТКРЫТЬ TELEGRAM";
    link.style.cssText = "display:inline-block;margin-top:14px;color:#ff7848";
    notice.append(title, message, link);
    document.body.replaceChildren(notice);
    return;
  }
  document.body.classList.add("autoflip-miniapp");
  try { telegram.ready(); telegram.expand(); } catch (_) {}
  const root = document.querySelector("[data-game-shell]");
  if (!root) return;
  const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  let profile = null;
  let activeTab = "home";
  let listings = [];
  const accountLink = document.querySelector("[data-account-link]");
  const node = (tag, cls, value) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (value !== undefined) el.textContent = String(value);
    return el;
  };
  const button = (label, tab) => {
    const el = node("button", "af-nav-item", label);
    el.type = "button";
    el.dataset.tab = tab;
    el.addEventListener("click", () => { activeTab = tab; render(); });
    return el;
  };
  async function api(path) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "API_UNAVAILABLE");
    return payload;
  }
  function frame() {
    root.replaceChildren();
    const top = node("header", "af-topbar");
    const logo = node("div", "af-logo", "AUTOFLIP");
    const tag = node("span", "af-online", "TELEGRAM EDITION");
    const help = node("a", "af-online", "ПОМОЩЬ");
    help.href = "https://autoflip-e2e-web-test.onrender.com/help.html";
    help.target = "_blank";
    help.rel = "noopener noreferrer";
    help.setAttribute("aria-label", "Открыть справочный центр AUTOFLIP");
    top.append(logo, tag, help);
    const content = node("div", "af-content");
    const nav = node("nav", "af-bottom-nav");
    nav.setAttribute("aria-label", "Игровые разделы");
    nav.append(button("Главная", "home"), button("Гараж", "garage"), button("Авторынок", "market"), button("Профиль", "profile"));
    root.append(top, content, nav);
    return { content, nav };
  }
  function sectionTitle(kicker, title, desc) {
    const wrap = node("div", "af-section-title");
    wrap.append(node("small", "", kicker), node("h1", "", title));
    if (desc) wrap.append(node("p", "", desc));
    return wrap;
  }
  function stats(player) {
    const grid = node("div", "af-stats");
    [["БАЛАНС", money.format(player.balance || 0) + " ₽"], ["УРОВЕНЬ", player.level || 1], ["ГАРАЖ", (player.garageUsed || 0) + " / " + (player.garageCapacity || 0)]].forEach(([k,v]) => {
      const card = node("div", "af-stat"); card.append(node("small", "", k), node("b", "", v)); grid.append(card);
    });
    return grid;
  }
  function renderHome(content) {
    const p = profile.player;
    content.append(sectionTitle("ТВОЙ АВТОМОБИЛЬНЫЙ БИЗНЕС", "Добро пожаловать, " + p.displayName, "Каждая сделка начинается с правильного выбора."));
    content.append(stats(p));
    const card = node("section", "af-feature");
    card.append(node("span", "af-kicker", "ДЕНЬ " + profile.gameDay), node("h2", "", "Твой путь перекупа"), node("p", "", "Изучай предложения, следи за состоянием машин и развивай свой гараж."));
    const go = node("button", "af-primary", "ОТКРЫТЬ АВТОРЫНОК");
    go.type = "button"; go.addEventListener("click", () => { activeTab = "market"; render(); });
    card.append(go); content.append(card);
    const quick = node("div", "af-quick");
    [["Мой гараж","garage"],["Профиль игрока","profile"]].forEach(([label,tab]) => {
      const b=node("button","af-quick-item",label+"  ↗"); b.type="button"; b.addEventListener("click",()=>{activeTab=tab;render();}); quick.append(b);
    });
    content.append(quick);
  }
  function renderGarage(content) {
    content.append(sectionTitle("МОЯ КОЛЛЕКЦИЯ", "Гараж", "Твои автомобили и их текущее состояние."));
    content.append(stats(profile.player));
    const cars = profile.garage || [];
    if (!cars.length) content.append(node("div","af-empty","В гараже пока нет автомобилей. Новые машины появятся здесь после игровых сделок."));
    cars.forEach((car,i) => {
      const card=node("article","af-car");
      card.append(node("div","af-car-art","🚘"), node("div","af-car-info"));
      const info=card.lastChild;
      info.append(node("small","","АВТОМОБИЛЬ / "+String(i+1).padStart(3,"0")),node("h3","",car.model));
      const specs=node("div","af-car-specs");
      [["ГОД",car.year || "—"],["ПРОБЕГ",(money.format(car.mileage||0)+" км")],["СОСТОЯНИЕ",(car.condition||0)+"%"],["НОМЕР",car.plate||"—"]].forEach(([k,v])=>specs.append(node("span","",k+": "+v)));
      info.append(specs); content.append(card);
    });
    if (profile.garageTruncated) content.append(node("p","af-muted","Показаны первые 50 автомобилей."));
    content.append(node("p","af-muted","В этой версии гараж доступен для просмотра. Управление автомобилями подключим отдельным безопасным игровым действием."));
  }
  function renderMarket(content) {
    content.append(sectionTitle("PLAYER MARKET", "Авторынок", "Предложения игроков из тестовой игровой базы."));
    const list=node("div","af-market-list");
    if (!listings.length) list.append(node("div","af-empty","Активных объявлений пока нет."));
    listings.forEach(item=>{
      const car=item.vehicle||{}, card=node("article","af-market-card");
      card.append(node("div","af-car-art","🚗"));
      const info=node("div","af-car-info");
      info.append(node("small","","АКТИВНОЕ ОБЪЯВЛЕНИЕ"),node("h3","",car.model||"Автомобиль"),node("b","af-price",money.format(item.askingPrice||0)+" ₽"));
      info.append(node("p","af-muted",(car.year||"—")+" · "+money.format(car.mileage||0)+" км · Состояние "+(car.condition||0)+"%"));
      const detail=node("p","af-muted","Номер: "+(car.plate||"—")+" · Повреждения: "+(car.damage||0));
      info.append(detail); card.append(info); list.append(card);
    });
    content.append(list,node("p","af-muted","Пока доступен просмотр объявлений. Покупки и списания не выполняются."));
  }
  function renderProfile(content) {
    const p=profile.player;
    content.append(sectionTitle("PLAYER ACCOUNT", "Профиль игрока", "Твой прогресс в AUTOFLIP."));
    const panel=node("section","af-profile-card");
    panel.append(node("div","af-avatar","AF"),node("h2","",p.displayName),node("p","af-muted","Игровой день "+profile.gameDay));
    panel.append(stats(p));
    [["Опыт",money.format(p.xp)+" XP"],["Репутация",money.format(p.respect)],["Долг",money.format(p.debt)+" ₽"],["Свободные места",Math.max(0,(p.garageCapacity||0)-(p.garageUsed||0))]].forEach(([k,v])=>{
      const row=node("div","af-profile-row"); row.append(node("span","",k),node("b","",v)); panel.append(row);
    });
    content.append(panel);
  }
  function render() {
    const {content,nav}=frame();
    nav.querySelectorAll("button").forEach(b=>b.classList.toggle("is-active",b.dataset.tab===activeTab));
    if (!profile) {
      content.append(sectionTitle("TELEGRAM / ACCOUNT", "Вход в AUTOFLIP", "Открой игру через Telegram. Для загрузки игрового профиля подтверди привязку аккаунта."));
      const auth=node("div","af-auth");
      if(accountLink) auth.append(accountLink);
      else auth.append(node("p","","Ожидаем защищённую Telegram-сессию…"));
      content.append(auth);
      return;
    }
    if(activeTab==="home") renderHome(content);
    if(activeTab==="garage") renderGarage(content);
    if(activeTab==="market") renderMarket(content);
    if(activeTab==="profile") renderProfile(content);
  }
  async function loadMarket() {
    try { const data=await api("/api/web/marketplace?limit=30"); listings=Array.isArray(data.listings)?data.listings:[]; }
    catch (_) { listings=[]; }
  }
  async function loadProfile() {
    try {
      const data=await api("/api/web/profile");
      profile=data.profile || null;
      if (profile) { await loadMarket(); render(); }
    } catch (_) { profile=null; render(); }
  }
  window.addEventListener("autoflip:profile", event => {
    profile=event.detail && event.detail.profile ? event.detail.profile : null;
    if(profile) { loadMarket().finally(render); } else render();
  });
  render();
  loadProfile();
})();