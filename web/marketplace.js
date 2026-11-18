"use strict";

(() => {
  const grid = document.querySelector("[data-marketplace-listings]");
  if (!grid) return;

  const searchForm = document.querySelector("[data-market-search]");
  const searchInput = searchForm?.querySelector('input[name="search"]');
  const countLabel = document.querySelector("[data-market-count]");
  const statusPanel = document.querySelector("[data-market-status]");
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
    const card = element("article", "listing-card");\n    card.tabIndex = 0;\n    card.setAttribute("role", "button");\n    card.setAttribute("aria-label", "Открыть подробности: " + (vehicle.model || "автомобиль"));\n    card.addEventListener("click", () => openListingDetails(listing));\n    card.addEventListener("keydown", event => {\n      if (event.target !== card) return;\n      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openListingDetails(listing); }\n    });
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
      element("span", "", "АКТИВНОЕ ОБЪЯВЛЕНИЕ")
    );
    body.append(top, title, specs, footer);
    card.append(photo, body);
    return card;
  }

  async function loadListings(search = "") {
    grid.setAttribute("aria-busy", "true");
    showMessage("ЗАГРУЖАЕМ РЕАЛЬНЫЕ ОБЪЯВЛЕНИЯ…");
    setStatus("ПОДКЛЮЧАЕМ АВТОРЫНОК", "Получаем данные тестовой базы.");
    if (countLabel) countLabel.textContent = "ЗАГРУЗКА…";

    const params = new URLSearchParams({ limit: "20" });
    if (search.trim()) params.set("search", search.trim());

    try {
      const response = await fetch("/api/web/marketplace?" + params.toString(), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        showMessage("ОТКРОЙТЕ AUTOFLIP В TELEGRAM MINI APP, ЧТОБЫ ПОСМОТРЕТЬ АВТОРЫНОК.");
        setStatus("ТРЕБУЕТСЯ ВХОД", "Авторынок доступен после проверки Telegram-сессии.", "warning");
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
        showMessage(search.trim()
          ? "ПО ЭТОМУ ЗАПРОСУ ОБЪЯВЛЕНИЙ НЕ НАЙДЕНО."
          : "ПОКА НЕТ АКТИВНЫХ ОБЪЯВЛЕНИЙ. КОГДА ИГРОКИ ВЫСТАВЯТ АВТОМОБИЛИ, ОНИ ПОЯВЯТСЯ ЗДЕСЬ.");
        setStatus("АВТОРЫНОК ПОДКЛЮЧЁН", "Активных объявлений пока нет. Игровые данные не изменялись.", "ready");
        return;
      }

      grid.replaceChildren(...listings.map(createListingCard));
      grid.setAttribute("aria-busy", "false");
      setStatus("АВТОРЫНОК ПОДКЛЮЧЁН", "Показаны реальные активные объявления из тестовой базы.", "ready");
    } catch (_) {
      showMessage("НЕ УДАЛОСЬ ЗАГРУЗИТЬ ОБЪЯВЛЕНИЯ. ПОПРОБУЙТЕ ОБНОВИТЬ СТРАНИЦУ.");
      setStatus("ОШИБКА ПОДКЛЮЧЕНИЯ", "Сервер авторынка временно не отвечает.", "warning");
      if (countLabel) countLabel.textContent = "ОШИБКА";
    }
  }

  searchForm?.addEventListener("submit", event => {
    event.preventDefault();
    loadListings(searchInput?.value || "");
  });

  loadListings();
})();
