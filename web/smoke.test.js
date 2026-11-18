const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "app.js"), "utf8");
const accountLink = fs.readFileSync(path.join(root, "account-link.js"), "utf8");
const accountLinkCss = fs.readFileSync(path.join(root, "account-link.css"), "utf8");

test("web shell references its local stylesheets and scripts", () => {
  assert.ok(html.includes('href="./styles.css"'));
  assert.ok(html.includes('href="./account-link.css"'));
  assert.ok(html.includes('src="./app.js"'));
  assert.ok(html.includes('src="./account-link.js"'));
  assert.ok(css.length > 1000);
  assert.ok(accountLinkCss.length > 100);
  assert.ok(js.length > 100);
  assert.ok(accountLink.length > 100);
});

test("all internal navigation anchors resolve to an element id", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const hrefs = [...html.matchAll(/\bhref="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) assert.ok(ids.has(href), "Missing target for #" + href);
});

test("mobile navigation has accessible control semantics", () => {
  assert.match(html, /class="menu-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-controls="primary-nav"/);
  assert.match(html, /id="primary-nav"/);
  assert.match(js, /addEventListener\("keydown"/);
  assert.match(js, /event\.key === "Escape"/);
});

test("connected marketplace is read-only and exposes personal listings", () => {
  assert.doesNotMatch(html, /DATABASE_URL|TELEGRAM_BOT_TOKEN|COPILOT_TOKEN/);
  assert.match(html, /data-marketplace-listings/);
  assert.match(html, /data-market-mine/);
  assert.match(html, /Покупка будет доступна только после проверки сделки/i);
  assert.doesNotMatch(html, /data-market-buy|data-listing-purchase/);
});

test("account linking is gated behind Telegram and same-origin API configuration", () => {
  assert.match(html, /data-account-link/);
  assert.match(html, /data-link-issue/);
  assert.match(html, /data-link-verify/);
  assert.match(accountLink, /Telegram\.WebApp/);
  assert.match(accountLink, /AUTOFLIP_WEB_API_BASE/);
  assert.match(accountLink, /url\.origin !== window\.location\.origin/);
  assert.match(accountLink, /credentials: "same-origin"/);
  assert.match(accountLink, /textContent/);
  assert.doesNotMatch(accountLink, /localStorage|sessionStorage/);
});

test("document has a language, viewport and main landmark", () => {
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<main id="main">/);
});
