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

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }
  function setBusy(value) {
    busy = value;
    issueButton.disabled = value || linked || !telegram || !apiBase;
    verifyButton.disabled = value || linked || !telegram || !apiBase || codePanel.hidden;
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
  async function issueCode() {
    if (busy) return;
    setBusy(true);
    setStatus("Проверяем Telegram и запрашиваем одноразовый код…");
    try {
      const { response, payload } = await post("/api/web/link-challenge");
      if (!response.ok) {
        if (response.status === 409) throw new Error("Этот Telegram-аккаунт уже привязан.");
        if (response.status === 429) throw new Error("Лимит запросов исчерпан. Попробуй позже.");
        if (response.status === 401) throw new Error("Telegram-сессия недействительна. Закрой и заново открой Mini App.");
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
        if (response.status === 401) throw new Error("Telegram-сессия устарела. Перезапусти Mini App.");
        throw new Error(payload.error || "Не удалось создать сессию.");
      }
      const profileResponse = await fetch(apiUrl("/api/web/profile"), { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!profileResponse.ok) throw new Error("Сессия создана, но профиль пока не удалось загрузить.");
      const profile = await profileResponse.json();
      codePanel.hidden = true;
      clearInterval(expiryTimer);
      const player = profile && profile.profile && profile.profile.username;
      linked = true;
      setStatus("Аккаунт успешно привязан. Защищённая сессия создана." + (player ? " Игрок: " + player : ""));
      verifyButton.disabled = true;
      issueButton.disabled = true;
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
  issueButton.disabled = false;
  verifyButton.disabled = true;
  issueButton.addEventListener("click", issueCode);
  verifyButton.addEventListener("click", verifyLink);
  copyButton.addEventListener("click", copyCode);
  setStatus("Telegram подтверждён. Можно запросить одноразовый код привязки.");
})();