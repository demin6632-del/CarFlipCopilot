# AUTOFLIP web API — security boundary and integration notes

Status: an isolated Telegram Mini App initData validator and regression tests now exist. No API endpoint, session, account mapping, or browser authorization is enabled by this work.

## Important finding from the current server

The existing `relay/server.js` is the Android companion relay, not a multi-user web API:

- It authenticates most HTTP routes and the WebSocket with one shared `COPILOT_TOKEN`.
- Its `latest` state is a process-level variable, not a per-player session.
- `GET /state` returns that single latest state.
- `/ws` broadcasts state and analysis messages to connected clients.

Therefore, a browser website must **not** be given `COPILOT_TOKEN`, must not call these endpoints as its account API, and must not reuse the shared WebSocket. Doing so could expose another connected player's latest game state and would not provide user-scoped authorization.

The Telegram bot's health server only exposes health status. The game module persists player state in `autonomous_game_state` keyed by `chat_id`; its exported `load(chat, firstName)` function creates/normalizes state and synchronizes the plate registry, so it is not a pure read-only query suitable for a page GET request.

## Isolated Telegram identity verification helper

File: `relay/telegram-webapp-auth.js`

- Validates raw `Telegram.WebApp.initData` with Telegram's documented HMAC-SHA-256 bot-token algorithm.
- Uses Node's built-in `crypto`; no new runtime dependency.
- Compares signatures with `timingSafeEqual`.
- Rejects duplicate query keys, malformed hashes, missing required fields, oversized payloads, stale timestamps (default maximum age: 15 minutes), and timestamps more than 30 seconds in the future.
- Parses the signed user object and returns a minimal identity DTO (`id`, first name, username, language code).
- Does not return the raw initData or hash, read the database, map Telegram users to game chats, issue cookies, or create sessions.

Regression tests: `relay/telegram-webapp-auth.test.js`; included in the relay's `npm test` script.

This helper is **not connected to an HTTP route or the live bot**. The caller must provide the bot token from a server-only environment variable. Never place it in frontend JavaScript, HTML, build-time public variables, or logs.

Official reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

## Recommended browser-facing boundary

Create a dedicated web API layer (or a separately isolated API service) that:

1. Verifies Telegram Mini App `initData` on the server using the bot token and Telegram's documented validation algorithm, including freshness checks.
2. Resolves a verified Telegram identity to one existing private player profile. Do not trust a client-supplied `chat_id`, `user.id`, owner ID, or role.
3. Issues a short-lived server-side session using Secure, HttpOnly, SameSite cookies. Keep bot tokens and database credentials server-side only.
4. Uses explicit allowlisted response DTOs. Never return the complete JSONB state or internal registry/ledger identifiers to the browser.
5. Separates read endpoints from mutation endpoints. Read endpoints must not call state-initializing or state-mutating helpers.
6. Requires CSRF protection for cookie-authenticated mutations, rate limits, authorization checks, and idempotency keys for financial or vehicle operations.
7. Reuses the existing transaction services for marketplace actions. Do not reimplement balance arithmetic or vehicle transfer in browser JavaScript.

## Suggested first API contract

All paths below are proposals, not live endpoints.

- `GET /api/v1/session` — current verified player identity and capability flags.
- `GET /api/v1/profile` — safe public/private profile fields for the current player.
- `GET /api/v1/garage` — current player's sanitized garage entries.
- `GET /api/v1/market/listings?cursor=...` — public active listings with bounded pagination.
- `GET /api/v1/market/listings/:id` — public listing details with seller-private identifiers omitted.
- `POST /api/v1/market/listings` — create a listing through the existing listing service after CSRF and ownership checks.
- `POST /api/v1/market/listings/:id/cancel` — seller-only cancellation.
- `POST /api/v1/market/listings/:id/purchase-confirmation` — return current price, balance and free garage capacity without charging.
- `POST /api/v1/market/listings/:id/purchase` — explicit confirmation, expected-price check and idempotent atomic settlement.

For the first frontend integration, implement only session/profile/garage/listing reads. Keep all mutation routes disabled until Telegram identity mapping, session lifecycle, CSRF and service-level tests are complete.

## Identity mapping must be verified before implementation

The current game state table uses `chat_id` as its primary key. Telegram Mini App supplies a signed Telegram user identity, but a Telegram user ID and a chat ID are not universally interchangeable (for example, group chat IDs differ). Before enabling website access, implement and test a deliberate mapping from verified Telegram user ID to the player's private bot chat/profile. Never accept a mapping supplied by the browser.

## Release restrictions

- No public browser route may expose `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `COPILOT_TOKEN`, Telegram API hashes, or full player JSONB.
- No direct browser-to-PostgreSQL access.
- No cross-player state reads.
- Preview must use isolated test identities and test data.
- Do not add the API service to Render or connect it to production until the owner explicitly approves the design, environment, backup, and rollout.
- Keep the 3D stage deferred.
