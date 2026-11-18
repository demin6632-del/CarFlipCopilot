"use strict";

(() => {
  const grid = document.querySelector("[data-marketplace-listings]");
  if (!grid) return;

  const searchForm = document.querySelector("[data-market-search]");
  const searchInput = searchForm?.querySelector('input[name="search"]');
  const countLabel = document.querySelector("[data-market-count]");
  const statusPanel = document.querySelector("[data-market-status]");
  const toolbar = document.querySelector(".market-toolbar");
  let showingMine = false;
  const mineButton = document.createElement("button");
  mineButton.type = "button";
  mineButton.className = "button button-outline market-mine-button";
  mineButton.textContent = "МОИ ОБЪЯВЛЕНИЯ";
  mineButton.setAttribute("aria-pressed", "false");
  if (toolbar) toolbar.insertBefore(mineButton, countLabel || null);
  const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function setStatus(title, detail, state = "info") {
    if (!statusPanel) return;
    statusPanel.dataset.state = state;
    const text = statusPanel.querySelector("span");
    if (!text) return;
    text.replaceChildren(element("b", "", title), element("small", "", detail));
  }

  function showMessage(message) {
    grid.replaceChildren(element("p", "market-empty", message));
    grid.setAttribute("aria-busy", "false");
  }

  function openListingDetails(listing) {
    const vehicle = listing.vehicle || {};
    const dialog = element("dialog", "listing-dialog");
    const panel = element("div", "listing-dialog-panel");
    const header = element("div", "listing-dialog-header");
    header.append(element("span", "", "AUTOFLIP / ПОДРОБНОСТИ ОБЪЯВЛЕНИЯ"));
    const close = element("button", "listing-dialog-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Закрыть подробности");
    close.addEventListener("click", () => dialog.close());
    header.append(close);
    const title = element("h2", "", vehicle.model || "Автомобиль");
    const price = element("p", "listing-dialog-price", money.format(Number(listing.askingPrice) || 0) + " ₽");
    const details = element("dl", "listing-dialog-specs");
    const rows = [
      ["Год выпуска", vehicle.year ?? "—"],
      ["Пробег", number.format(Number(vehicle.mileage) || 0) + " км"],
      ["Состояние", (Number(vehicle.condition) || 0) + "%"],
      ["Повреждения", Number(vehicle.damage) || 0],
      ["Государственный номер", vehicle.plate || "Не указан"],
      ["Статус", listing.status === "active" ? "Активное объявление" : listing.status || "—"]
    ];
    for (const [label, value] of rows) {
      details.append(element("dt", "", label), element("dd", "", value));
    }
    const note = element("p", "listing-dialog-note", "Это просмотр объявления. Покупка и любые изменения игрового баланса здесь не выполняются.");
    const footer = element("div", "listing-dialog-actions");
    const done = element("button", "button button-primary", "ЗАКРЫТЬ");
    done.type = "button";
    done.addEventListener("click", () => dialog.close());
    footer.append(done);
    panel.append(header, title, price, details, note, footer);
    dialog.append(panel);
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function createListingCard(listing) {
    const vehicle = listing.vehicle || {};
    const card = element("article", "listing-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "Открыть подробности: " + (vehicle.model || "автомобиль"));
    card.addEventListener("click", () => openListingDetails(listing));
    card.addEventListener("keydown", event => {
      if (event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openListingDetails(listing); }
    });
    const photo = element("div", "listing-photo listing-photo-placeholder");
    photo.setAttribute("aria-label", "Фотография автомобиля пока не добавлена");
    photo.append(element("span", "", "ФОТО НЕ ДОБАВЛЕНО"));

    const body = element("div", "listing-body");
    const top = element("div", "listing-top");
    top.append(
      element("span", "", "ОБЪЯВЛЕНИЕ AUTOFLIP"),
      element("b", "", money.format(Number(listing.askingPrice) || 0) + " ₽")
    );

    const title = element("h3", "", vehicle.model || "Автомобиль");
    const specs = element("div", "listing-specs");
    const fields = [
      ["ГОД", vehicle.year || "—"],
      ["ПРОБЕГ", number.format(Number(vehicle.mileage) || 0) + " км"],
      ["СОСТОЯНИЕ", (Number(vehicle.condition) || 0) + "%"]
    ];
    for (const [label, value] of fields) {
      const field = element("span", "", label);
      field.append(element("b", "", value));
      specs.append(field);
    }

    const footer = element("div", "listing-footer");
    footer.append(
      element("span", "", vehicle.plate ? "НОМЕР " + vehicle.plate : "НОМЕР НЕ УКАЗАН"),
      element("span", "", listing.status === "active" ? "АКТИВНОЕ ОБЪЯВЛЕНИЕ" : "СТАТУС: " + String(listing.status || "НЕИЗВЕСТЕН").toUpperCase())
    );
    body.append(top, title, specs, footer);
    card.append(photo, body);
    return card;
  }

  async function loadListings(search = "", endpoint = "/api/web/marketplace") {
    grid.setAttribute("aria-busy", "true");
    showMessage("ЗАГРУЖАЕМ РЕАЛЬНЫЕ ОБЪЯВЛЕНИЯ…");
    setStatus("ПОДКЛЮЧАЕМ АВТОРЫНОК", "Получаем данные тестовой базы.");
    if (countLabel) countLabel.textContent = "ЗАГРУЗКА…";

    const params = new URLSearchParams({ limit: "20" });
    if (endpoint === "/api/web/marketplace" && search.trim()) params.set("search", search.trim());

    try {
      const response = await fetch(endpoint + "?" + params.toString(), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        const ownListings = endpoint.endsWith("/mine");
        showMessage(ownListings ? "ПРИВЯЖИТЕ TELEGRAM-АККАУНТ, ЧТОБЫ ПОСМОТРЕТЬ СВОИ ОБЪЯВЛЕНИЯ." : "ОТКРОЙТЕ AUTOFLIP В TELEGRAM MINI APP, ЧТОБЫ ПОСМОТРЕТЬ АВТОРЫНОК.");
        setStatus("ТРЕБУЕТСЯ ВХОД", ownListings ? "Для личных объявлений нужна активная привязка Telegram." : "Авторынок доступен после проверки Telegram-сессии.", "warning");
        if (countLabel) countLabel.textContent = "НУЖЕН ВХОД";
        return;
      }
      if (response.status === 503 || payload.error === "MARKETPLACE_NOT_READY") {
        showMessage("АВТОРЫНОК ВРЕМЕННО НЕДОСТУПЕН. СХЕМА БАЗЫ НЕ ГОТОВА.");
        setStatus("БАЗА НЕ ГОТОВА", "Проверьте подключение тестовой базы.", "warning");
        if (countLabel) countLabel.textContent = "НЕДОСТУПНО";
        return;
      }
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.listings)) {
        throw new Error(payload.error || "MARKETPLACE_LOAD_FAILED");
      }

      const listings = payload.listings;
      if (countLabel) countLabel.textContent = "ОБЪЯВЛЕНИЙ: " + listings.length;
      if (!listings.length) {
        showMessage(endpoint.endsWith("/mine")
          ? "У ТЕБЯ ПОКА НЕТ ОБЪЯВЛЕНИЙ."
          : search.trim() ? "ПО ЭТОМУ ЗАПРОСУ ОБЪЯВЛЕНИЙ НЕ НАЙДЕНО." : "ПОКА НЕТ АКТИВНЫХ ОБЪЯВЛЕНИЙ. КОГДА ИГРОКИ ВЫСТАВЯТ АВТОМОБИЛИ, ОНИ ПОЯВЯТСЯ ЗДЕСЬ.");
        setStatus(endpoint.endsWith("/mine") ? "МОИ ОБЪЯВЛЕНИЯ" : "АВТОРЫНОК ПОДКЛЮЧЁН", endpoint.endsWith("/mine") ? "Активных или завершённых личных объявлений нет." : "Активных объявлений пока нет. Игровые данные не изменялись.", "ready");
        return;
      }

      grid.replaceChildren(...listings.map(createListingCard));
      grid.setAttribute("aria-busy", "false");
      setStatus(endpoint.endsWith("/mine") ? "МОИ ОБЪЯВЛЕНИЯ" : "АВТОРЫНОК ПОДКЛЮЧЁН", endpoint.endsWith("/mine") ? "Показаны объявления твоего аккаунта." : "Показаны реальные активные объявления из тестовой базы.", "ready");
    } catch (_) {
      showMessage("НЕ УДАЛОСЬ ЗАГРУЗИТЬ ОБЪЯВЛЕНИЯ. ПОПРОБУЙТЕ ОБНОВИТЬ СТРАНИЦУ.");
      setStatus("ОШИБКА ПОДКЛЮЧЕНИЯ", "Сервер авторынка временно не отвечает.", "warning");
      if (countLabel) countLabel.textContent = "ОШИБКА";
    }
  }

  mineButton.addEventListener("click", () => {
    showingMine = !showingMine;
    mineButton.textContent = showingMine ? "ВСЕ ОБЪЯВЛЕНИЯ" : "МОИ ОБЪЯВЛЕНИЯ";
    mineButton.setAttribute("aria-pressed", String(showingMine));
    if (searchInput) searchInput.value = "";
    loadListings("", showingMine ? "/api/web/marketplace/mine" : "/api/web/marketplace");
  });

  searchForm?.addEventListener("submit", event => {
    event.preventDefault();
    showingMine = false;
    mineButton.textContent = "МОИ ОБЪЯВЛЕНИЯ";
    mineButton.setAttribute("aria-pressed", "false");
    loadListings(searchInput?.value || "", "/api/web/marketplace");
  });

  loadListings();
})();
