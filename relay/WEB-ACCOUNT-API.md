# AUTOFLIP Web Account API (isolated service)

This is a separate API process. It must not be mounted into the legacy relay/server.js:
that server exposes a shared-token companion bridge with process-global state and WebSocket broadcasts.

## Start

Run from relay/:

- npm run start:web

Required environment variables:

- DATABASE_URL — Neon connection string (never commit it)
- TELEGRAM_BOT_TOKEN — bot token used only to verify Telegram Mini App initData
- WEB_APP_ORIGIN — exact HTTPS origin of the Mini App/site, e.g. https://app.example.com
- PORT — optional; defaults to 10000
- DATABASE_SSL=false — only for local PostgreSQL; production should keep SSL enabled

## Routes

- GET /health — minimal health check; runs SELECT 1
- POST /api/web/link-challenge — verifies signed Telegram Mini App initData and issues a one-time code for `/link`; only the SHA-256 digest is stored, with a five-minute TTL and a five-per-hour issuance limit.
- POST /api/web/session — verifies signed Telegram initData, requires a pre-existing account link, then creates an opaque server-side session
- GET /api/web/profile — returns an allowlisted player and garage DTO
- POST /api/web/logout — revokes the session

Session cookie: __Host-autoflip_session, HttpOnly, Secure, SameSite=Strict, Path=/.
Only a SHA-256 digest of the random cookie token is stored in PostgreSQL.

## Database rollout

Apply, in order, only after an explicitly approved deployment plan:

1. telegram-account-linking.sql
2. web-account-sessions.sql

Both migrations are additive. The application does not run migrations on startup.

## Security and rollout boundaries

- This service does not serve static files and does not expose /state, /ws, /bridge/state, or /attachments.
- The HTTP server is intentionally separate from the existing Android companion relay and Telegram polling process.
- The `/link CODE` handler is prepared in the Telegram bot, but remains disabled unless `AUTOFLIP_ACCOUNT_LINKING_ENABLED=true` is explicitly configured. It accepts private-chat messages only and verifies the sender Telegram user ID.
- The Mini App challenge endpoint is isolated in the web API; neither endpoint is deployed or connected to the live bot.
- No production migration, Render service creation, deployment, or live bot change is authorized by this code.
- Session issuance is limited to 10 successful-initData attempts per linked Telegram account per rolling hour. Before public exposure, add expired-session cleanup, configure the exact allowed origin, verify the account-link flow end-to-end, and review operational monitoring.
