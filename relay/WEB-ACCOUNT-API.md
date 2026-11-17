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
- POST /api/web/session — verifies signed Telegram initData, requires a pre-existing account link, then creates an opaque server-side session
- GET /api/web/profile — returns an allowlisted player and garage DTO
- POST /api/web/logout — revokes the session

Session cookie: __Host-autoflip_session, HttpOnly, Secure, SameSite=Strict, Path=/.
Only a SHA-256 digest of the random cookie token is stored in PostgreSQL.

## Expired session maintenance

Run a bounded cleanup batch from `relay/` with `npm run web:sessions:cleanup`. It requires `DATABASE_URL`, deletes only rows whose `expires_at` is at or before the PostgreSQL clock, and defaults to at most 200 rows per run. Set `SESSION_CLEANUP_BATCH_SIZE` to an integer from 1 to 1000 to change the batch size. The query uses `FOR UPDATE SKIP LOCKED`, so overlapping maintenance runs do not wait on rows another worker has locked. Schedule this command externally only after the web API rollout is explicitly approved; it is not started automatically by the API server. Re-run it on a schedule to drain larger backlogs gradually.

## Database rollout

Apply, in order, only after an explicitly approved deployment plan:

1. telegram-account-linking.sql
2. web-account-sessions.sql

Both migrations are additive. The application does not run migrations on startup.

## Security and rollout boundaries

- This service does not serve static files and does not expose /state, /ws, /bridge/state, or /attachments.
- The HTTP server is intentionally separate from the existing Android companion relay and Telegram polling process.
- No Telegram /link command or account-link challenge has been wired into the live bot.
- No production migration, Render service creation, deployment, or live bot change is authorized by this code.
- Session issuance is limited to 10 successful-initData attempts per linked Telegram account per rolling hour. Before public exposure, add expired-session cleanup, configure the exact allowed origin, verify the account-link flow end-to-end, and review operational monitoring.
