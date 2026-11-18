(() => {
  "use strict";
  const root = document.querySelector("[data-account-link]");
  if (!root) return;
  const status = root.querySelector("[data-link-status]");
  const issueButton = root.querySelector("[data-link-issue]");
  const verifyButton = root.querySelector("[data-link-verify]");
  const codePanel = root.querySelector("[data-link-code-panel]");
  const codeInput = root.querySelector("[data-link-code]");
  const copyButton = root.querySelector("[data-link-copy]");
  const expiryLabel = root.querySelector("[data-link-expiry]");
  const telegram = window.Telegram && window.Telegram.WebApp;
  const apiBase = typeof window.AUTOFLIP_WEB_API_BASE === "string" ? window.AUTOFLIP_WEB_API_BASE.trim() : "";
  let expiresAt = 0;
  let expiryTimer = null;
  let busy = false;
  let linked = false;
  let authFailed = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }
  function setBusy(value) {
    busy = value;
    issueButton.disabled = value || linked || authFailed || !telegram || !apiBase;
    verifyButton.disabled = value || linked || authFailed || !telegram || !apiBase || codePanel.hidden;
    issueButton.textContent = value ? "ПОДОЖДИ…" : "ПОЛУЧИТЬ КОД";
  }
  function apiUrl(path) {
    const url = new URL(apiBase, window.location.href);
    if (url.origin !== window.location.origin) throw new Error("API должен находиться на том же домене, что и Mini App.");
    return new URL(path, url.href).toString();
  }
  async function post(path) {
    const response = await fetch(apiUrl(path), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: telegram.initData })
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    return { response, payload };
  }
  function showExpiry() {
    if (!expiresAt) return;
    const seconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
    expiryLabel.textContent = seconds
      ? "Код истекает через " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
      : "Срок действия кода истёк. Получи новый код.";
    if (!seconds) clearInterval(expiryTimer);
  }
  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("ru-RU").format(number) : "—";
  }
  function addText(parent, tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    parent.appendChild(node);
    return node;
  }
  function renderGameProfile(payload) {
    if (!payload || payload.profileStatus !== "CONNECTED" || !payload.profile) return;
    const profile = payload.profile;
    const player = profile.player || {};
    const garage = Array.isArray(profile.garage) ? profile.garage : [];
    const stats = document.querySelectorAll(".profile-stats > div");
    if (stats[0]) stats[0].querySelector("b").textContent =
      formatNumber(player.garageUsed) + " / " + formatNumber(player.garageCapacity);
    if (stats[1]) stats[1].querySelector("b").textContent = formatNumber(player.balance) + " ₽";
    if (stats[2]) stats[2].querySelector("b").textContent = formatNumber(player.respect);
    const profileName = document.querySelector(".profile-user b");
    const profileCaption = document.querySelector(".profile-user small");
    if (profileName) profileName.textContent = player.displayName || "Игрок AUTOFLIP";
    if (profileCaption) profileCaption.textContent = "Уровень " + formatNumber(player.level) +
      " · " + formatNumber(player.xp) + " XP · Игровой день " + formatNumber(profile.gameDay);
    const badge = document.querySelector(".mock-badge");
    if (badge) badge.textContent = "CONNECTED";
    const lock = document.querySelector(".profile-lock");
    if (lock) lock.hidden = true;
    const overview = document.querySelector("#profile-panel-overview");
    if (overview) {
      overview.replaceChildren();
      addText(overview, "b", "", "ПРОФИЛЬ ИГРОКА");
      addText(overview, "p", "", "Игрок: " + (player.displayName || "—") +
        ". Уровень " + formatNumber(player.level) + ", опыт " + formatNumber(player.xp) +
        ", репутация " + formatNumber(player.respect) + ".");
      addText(overview, "p", "profile-detail", "Игровой день: " + formatNumber(profile.gameDay) +
        ". Свободно мест в гараже: " +
        formatNumber(Math.max(0, Number(player.garageCapacity || 0) - Number(player.garageUsed || 0))) + ".");
      addText(overview, "small", "", "ДАННЫЕ ПОЛУЧЕНЫ ИЗ ИГРОВОГО ПРОФИЛЯ");
    }
    const finance = document.querySelector("#profile-panel-finance");
    if (finance) {
      finance.replaceChildren();
      addText(finance, "b", "", "ФИНАНСЫ И ОПЕРАЦИИ");
      addText(finance, "p", "", "Игровой баланс: " + formatNumber(player.balance) + " ₽.");
      if (player.debt !== undefined && player.debt !== null && Number.isFinite(Number(player.debt))) {
        addText(finance, "p", "profile-detail", "Текущий долг: " + formatNumber(player.debt) + " ₽.");
      } else {
        addText(finance, "p", "profile-detail", "Информация о долге не передана игровым сервером.");
      }
      addText(finance, "p", "profile-detail", "История операций пока недоступна: сервер не передаёт журнал транзакций.");
      addText(finance, "small", "", "БАЛАНС ЗАГРУЖЕН ИЗ ИГРОВОГО ПРОФИЛЯ · ПОКУПКИ И ПЕРЕВОДЫ НЕ ВЫПОЛНЯЮТСЯ");
    }
    const security = document.querySelector("#profile-panel-security");
    if (security) {
      security.replaceChildren();
      addText(security, "b", "", "ЗАЩИТА АККАУНТА");
      addText(security, "p", "", "Статус Telegram: аккаунт привязан.");
      addText(security, "p", "profile-detail", "Статус сессии: активна на момент проверки.");
      addText(security, "p", "profile-detail", "Игровой профиль загружен через защищённый серверный API.");
      addText(security, "small", "", "СЕКРЕТЫ И ДАННЫЕ СЕССИИ НЕ ПОКАЗЫВАЮТСЯ · УПРАВЛЕНИЕ СЕССИЯМИ ПОКА НЕ ПОДДЕРЖИВАЕТСЯ");
    }
    const garagePanel = document.querySelector("#profile-panel-garage");
    if (garagePanel) {
      garagePanel.replaceChildren();
      addText(garagePanel, "b", "", "ГАРАЖ И ИСТОРИЯ МАШИН");
      addText(garagePanel, "p", "", "Занято мест: " + formatNumber(player.garageUsed) +
        " из " + formatNumber(player.garageCapacity) + ".");
      if (!garage.length) {
        addText(garagePanel, "small", "", "В ГАРАЖЕ ПОКА НЕТ АВТОМОБИЛЕЙ");
      } else {
        garage.forEach((car) => {
          const item = addText(garagePanel, "article", "profile-car-row", "");
          addText(item, "b", "", car.model || "Автомобиль");
          addText(item, "span", "", "Год: " + (car.year || "—") +
            " · Номер: " + (car.plate || "—") +
            " · Пробег: " + formatNumber(car.mileage) + " км" +
            " · Состояние: " + formatNumber(car.condition) + "%");
        });
      }
    }
    const garageSummary = document.querySelector(".garage-summary");
    if (garageSummary) {
      const values = garageSummary.querySelectorAll("div b");
      if (values[0]) values[0].textContent = formatNumber(player.garageUsed) +
        " / " + formatNumber(player.garageCapacity);
      if (values[1]) values[1].textContent = "— ₽";
      if (values[2]) values[2].textContent = garage.length ? "ДАННЫЕ ЗАГРУЖЕНЫ" : "ПОКА НЕТ АВТОМОБИЛЕЙ";
    }
    const garageCars = document.querySelector(".garage-cars");
    if (garageCars) {
      garageCars.replaceChildren();
      if (!garage.length) {
        const empty = addText(garageCars, "article", "garage-car garage-empty", "");
        addText(empty, "b", "", "В ГАРАЖЕ ПОКА НЕТ АВТОМОБИЛЕЙ");
        addText(empty, "span", "", "СВОБОДНО МЕСТ: " +
          formatNumber(Math.max(0, Number(player.garageCapacity || 0) - Number(player.garageUsed || 0))));
      } else {
        garage.forEach((car, index) => {
          const card = addText(garageCars, "article", "garage-car garage-car-live", "");
          const info = addText(card, "div", "garage-car-info", "");
          addText(info, "span", "", "АВТОМОБИЛЬ / " + String(index + 1).padStart(3, "0"));
          addText(info, "h4", "", car.model || "Автомобиль");
          addText(info, "p", "", "Год выпуска " + (car.year || "—") +
            " · Пробег " + formatNumber(car.mileage) + " км");
          const plate = addText(info, "div", "", "");
          addText(plate, "span", "", "ГОСНОМЕР");
          addText(plate, "strong", "", car.plate || "—");
          addText(info, "p", "", "Состояние: " + formatNumber(car.condition) + "%");
        });
      }
    }
    const disclaimer = document.querySelector(".showcase-disclaimer");
    if (disclaimer) disclaimer.textContent = "Гараж загружен из игрового профиля. Стоимость автомобилей не передаётся источником данных и поэтому не рассчитывается.";
    const accountIntro = document.querySelector(".account-layout > div > p");
    if (accountIntro) accountIntro.textContent = "Защищённый аккаунт подключён. Данные профиля загружаются из игрового сервера.";
    const accountNote = document.querySelector(".account-note");
    if (accountNote) accountNote.textContent = "ИГРОВОЙ ПРОФИЛЬ ПОДКЛЮЧЁН";
  }
  function markLinked(profile) {
    codePanel.hidden = true;
    clearInterval(expiryTimer);
    linked = true;
    const player = profile && profile.profile && profile.profile.player && profile.profile.player.displayName;
    const gameDataReady = profile && profile.profileStatus === "CONNECTED" && profile.profile;
    if (gameDataReady) renderGameProfile(profile);
    setStatus(
      "Telegram-аккаунт успешно привязан. Защищённая сессия активна." +
      (player ? " Игрок: " + player + "." : "") +
      (gameDataReady ? " Игровой профиль загружен." : " Игровые данные пока не подключены.")
    );
    issueButton.disabled = true;
    verifyButton.disabled = true;
  }

  async function loadProfile() {
    const response = await fetch(apiUrl("/api/web/profile"), {
      method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error("Не удалось загрузить профиль после входа.");
    return response.json();
  }

  async function restoreAccount() {
    if (busy) return;
    setBusy(true);
    setStatus("Проверяем сохранённую сессию AUTOFLIP…");
    try {
      const existing = await fetch(apiUrl("/api/web/profile"), {
        method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }
      });
      if (existing.ok) {
        markLinked(await existing.json());
        return;
      }
      if (existing.status !== 401) throw new Error("Сервер временно недоступен. Попробуй позже.");
      const { response, payload } = await post("/api/web/session");
      if (response.ok) {
        markLinked(await loadProfile());
        return;
      }
      if (response.status === 403 && payload.error === "TELEGRAM_ACCOUNT_NOT_LINKED") {
        setStatus("Telegram подтверждён. Аккаунт ещё не привязан — получи одноразовый код.");
        return;
      }
      if (response.status === 401) {
        authFailed = true;
        throw new Error("Telegram-сессия недействительна. Закрой и заново открой Mini App.");
      }
      if (response.status === 429) throw new Error("Слишком много попыток входа. Попробуй позже.");
      throw new Error(payload.error || "Не удалось восстановить вход.");
    } catch (error) {
      setStatus(error.message || "Не удалось проверить аккаунт.", true);
    } finally {
      setBusy(false);
    }
  }

  async function issueCode() {
    if (busy || linked || authFailed) return;
    setBusy(true);
    setStatus("Проверяем Telegram и запрашиваем одноразовый код…");
    try {
      const { response, payload } = await post("/api/web/link-challenge");
      if (!response.ok) {
        if (response.status === 409) throw new Error("Этот Telegram-аккаунт уже привязан.");
        if (response.status === 429) throw new Error("Лимит запросов исчерпан. Попробуй позже.");
        if (response.status === 401) {
          authFailed = true;
          throw new Error("Telegram-сессия недействительна. Закрой и заново открой Mini App.");
        }
        throw new Error(payload.error || "Не удалось получить код привязки.");
      }
      if (!/^[A-F0-9]{32}$/.test(payload.code || "") || !Number.isFinite(payload.expiresAt)) throw new Error("Сервер вернул некорректный ответ.");
      codeInput.value = payload.code;
      codePanel.hidden = false;
      expiresAt = payload.expiresAt;
      clearInterval(expiryTimer);
      showExpiry();
      expiryTimer = setInterval(showExpiry, 1000);
      verifyButton.disabled = false;
      setStatus("Код готов. Отправь боту в личном чате команду /link КОД.");
    } catch (error) {
      setStatus(error.message || "Ошибка запроса.", true);
    } finally {
      setBusy(false);
      if (codePanel.hidden) verifyButton.disabled = true;
    }
  }
  async function verifyLink() {
    if (busy) return;
    setBusy(true);
    setStatus("Проверяем привязку и создаём защищённую сессию…");
    try {
      const { response, payload } = await post("/api/web/session");
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) throw new Error("Привязка пока не найдена. Сначала отправь боту /link КОД, затем повтори проверку.");
        if (response.status === 401) {
          authFailed = true;
          throw new Error("Telegram-сессия устарела. Перезапусти Mini App.");
        }
        throw new Error(payload.error || "Не удалось создать сессию.");
      }
      const profile = await loadProfile();
      markLinked(profile);
    } catch (error) {
      setStatus(error.message || "Ошибка проверки.", true);
    } finally {
      setBusy(false);
    }
  }
  async function copyCode() {
    if (!codeInput.value) return;
    try {
      await navigator.clipboard.writeText(codeInput.value);
      copyButton.textContent = "СКОПИРОВАНО";
    } catch (_) {
      codeInput.focus(); codeInput.select();
      setStatus("Выделил код — скопируй его вручную.", true);
    }
  }
  if (!telegram || !telegram.initData) {
    setStatus("Открой AUTOFLIP внутри Telegram Mini App, чтобы привязать аккаунт.");
    return;
  }
  if (!apiBase) {
    setStatus("Интерфейс готов, но сервер привязки ещё не подключён. Запросы и изменения аккаунта пока не выполняются.");
    return;
  }
  try {
    const configuredUrl = new URL(apiBase, window.location.href);
    if (configuredUrl.origin !== window.location.origin) {
      setStatus("Привязка отключена: API должен работать на том же домене.", true);
      return;
    }
  } catch (_) {
    setStatus("Неверная настройка адреса API.", true);
    return;
  }
  telegram.ready();
  issueButton.addEventListener("click", issueCode);
  verifyButton.addEventListener("click", verifyLink);
  copyButton.addEventListener("click", copyCode);
  restoreAccount();
})();