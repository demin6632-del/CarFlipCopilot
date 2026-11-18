const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appHtml = fs.readFileSync(path.join(root, "app.html"), "utf8");
const helpCss = fs.readFileSync(path.join(root, "help.css"), "utf8");
const gameShell = fs.readFileSync(path.join(root, "game-shell.js"), "utf8");
const accountLink = fs.readFileSync(path.join(root, "account-link.js"), "utf8");

test("public website is a help center, not a browser game", () => {
  assert.match(html, /справочный центр/i);
  assert.match(html, /КАК НАЧАТЬ ИГРАТЬ/);
  assert.match(html, /ЧАСТЫЕ ВОПРОСЫ/);
  assert.match(html, /Сама игра живёт внутри Telegram Mini App/);
  assert.doesNotMatch(html, /data-game-shell|game-shell\.js|marketplace\.js|data-marketplace-listings/);
  assert.ok(helpCss.length > 1000);
});

test("game shell is isolated on the dedicated Telegram Mini App page", () => {
  assert.match(appHtml, /data-game-shell/);
  assert.match(appHtml, /game-shell\.js/);
  assert.match(appHtml, /Telegram\.WebApp/);
  assert.match(appHtml, /AUTOFLIP_WEB_API_BASE/);
  assert.match(gameShell, /Telegram\.WebApp/);
  assert.match(gameShell, /initData/);
});

test("account linking remains protected by Telegram initData and same-origin API", () => {
  assert.match(appHtml, /data-account-link/);
  assert.match(appHtml, /data-link-issue/);
  assert.match(appHtml, /data-link-verify/);
  assert.match(accountLink, /Telegram\.WebApp/);
  assert.match(accountLink, /AUTOFLIP_WEB_API_BASE/);
  assert.match(accountLink, /url\.origin !== window\.location\.origin/);
  assert.match(accountLink, /credentials: "same-origin"/);
  assert.match(accountLink, /textContent/);
  assert.doesNotMatch(accountLink, /localStorage|sessionStorage/);
});

test("help page links to the Telegram bot and provides safe account guidance", () => {
  assert.match(html, /https:\/\/t\.me\/autoflip_test_bot/);
  assert.match(html, /\/link КОД/);
  assert.match(html, /Не отправляй пароли, токены/);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<main id="top">/);
});
