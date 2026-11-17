const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "app.js"), "utf8");

test("web shell references its local stylesheet and script", () => {
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.ok(css.length > 1000);
  assert.ok(js.length > 100);
});

test("all internal navigation anchors resolve to an element id", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const hrefs = [...html.matchAll(/\bhref="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) assert.ok(ids.has(href), `Missing target for #${href}`);
});

test("mobile navigation has accessible control semantics", () => {
  assert.match(html, /class="menu-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-controls="primary-nav"/);
  assert.match(html, /id="primary-nav"/);
  assert.match(js, /addEventListener\("keydown"/);
  assert.match(js, /event\.key === "Escape"/);
});

test("the preview does not expose credentials or imply live account features", () => {
  assert.doesNotMatch(html, /DATABASE_URL|TELEGRAM_BOT_TOKEN|COPILOT_TOKEN/);
  assert.match(html, /после подключения и проверки безопасного серверного API/i);
  assert.match(html, /Купить здесь пока нельзя/i);
  assert.match(html, /ИНТЕРФЕЙС ЛИЧНОГО КАБИНЕТА ГОТОВИТСЯ/i);
});

test("the premium automotive sections and imagery are present", () => {
  assert.match(html, /class="hero-photo"/);
  assert.match(html, /id="garage"/);
  assert.match(html, /id="market"/);
  assert.match(html, /id="racing"/);
  assert.match(css, /--orange:#f05a28/);
  assert.match(css, /@media\(max-width:680px\)/);
});

test("document has a language, viewport and main landmark", () => {
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<main id="main">/);
});

test("mobile menu supports outside click, focus handling and active section state", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(app, /document\.addEventListener\("click"/);
  assert.match(app, /event\.key === "Tab"/);
  assert.match(app, /IntersectionObserver/);
  assert.match(app, /aria-current/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /body\.menu-open/);
});

test("garage showcase is clearly marked as a preview with no fabricated player data", () => {
  assert.match(html, /id="garage"[^>]*aria-labelledby="garage-title"/);
  assert.match(html, /КОНЦЕПТ ИНТЕРФЕЙСА/);
  assert.match(html, /Реальные автомобили, номера, пробег и стоимость появятся после подключения игровых данных/);
  assert.match(html, /ГОСНОМЕР/);
  assert.match(css, /\.garage-cars\{display:grid/);
});

test("marketplace cards are illustrative and cannot be mistaken for live listings", () => {
  assert.match(html, /НЕ АКТИВНЫЕ ОБЪЯВЛЕНИЯ/);
  assert.match(html, /РЫНОК В РАЗРАБОТКЕ/);
  assert.match(html, /Купить здесь пока нельзя/);
  assert.match(html, /class="listing-grid"/);
  assert.match(css, /\.listing-grid\{display:grid/);
});

test("all element ids are unique", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "Duplicate HTML id found");
});

\ntest("account preview has accessible overview, garage, finance and security tabs", () => {
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-profile-tab="overview"/);
  assert.match(html, /data-profile-tab="garage"/);
  assert.match(html, /data-profile-tab="finance"/);
  assert.match(html, /data-profile-tab="security"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /id="profile-panel-security"[^>]*hidden/);
  assert.match(js, /event\.key === "ArrowRight"/);
  assert.match(js, /activateProfileTab/);
  assert.match(css, /\.profile-tab\.is-active/);
  assert.match(html, /ДЕМОНСТРАЦИОННЫЙ ИНТЕРФЕЙС · БЕЗ ПОДКЛЮЧЕНИЯ К ИГРЕ/);
});
