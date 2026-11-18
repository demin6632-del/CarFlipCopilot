# AUTOFLIP Telegram /link command

The Telegram bot accepts \`/link CODE\` only in a private chat.

## Full account-link flow

1. The player opens AUTOFLIP inside Telegram Mini App.
2. The isolated web API validates the signed Telegram \`initData\` and issues a one-time challenge for that verified Telegram user ID.
3. The Mini App displays the code for five minutes. Only its SHA-256 digest is stored in PostgreSQL.
4. The player sends \`/link CODE\` to the bot in a private chat.
5. The bot uses Telegram's authenticated \`message.from.id\` and \`message.chat.id\`; neither identifier is accepted from user text.
6. The confirmation service checks ownership, expiry, unused status and unique mapping constraints in one transaction.
7. The player returns to the Mini App, which creates a protected web session and reads the allowlisted profile.

## Security behavior

- Group chats are rejected before any database operation.
- Codes contain 128 bits of randomness, expire after five minutes, and are limited to five issuances per hour per Telegram user.
- Only a SHA-256 digest is persisted; plaintext codes and Telegram \`initData\` must not be logged.
- Replays, expired codes, wrong Telegram users and conflicting profile mappings are rejected.
- Database errors are logged server-side and replaced with a generic user-facing message.
- The bot command is registered in the private-chat command menu and included in \`/help\`.

## Rollout boundary

This implementation exists only in the draft pull-request chain. It is not connected to the live bot, no migration has been applied to Neon, and no Render service has been deployed. The API, both additive migrations, same-origin reverse proxy and bot command must pass an approved end-to-end rollout before the website enables requests.
