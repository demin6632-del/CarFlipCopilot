# AUTOFLIP Telegram /link command

This branch adds a private-chat-only `/link CODE` command to the bot.

## Behavior

- The bot accepts the command only when Telegram reports `chat.type === "private"`.
- The linked identity is taken from the authenticated update fields: `message.from.id` and `message.chat.id`; the command never accepts either identifier from user-supplied text.
- Confirmation delegates to `confirmTelegramAccountLink`, which checks the one-time code digest, matching Telegram user ID, expiry, unused status, and uniqueness inside a database transaction.
- Group chats are rejected before any database operation.
- Database errors are logged server-side and replaced with a generic user-facing message. The code itself is never logged.
- The command is registered in the bot command menu and included in `/help`.

## Important incomplete part

The command consumes a code but does not issue one. A trusted Mini App/API flow that authenticates Telegram `initData` and issues a challenge for that exact Telegram user is still required. Until that issuer and the account-link migration are reviewed and deliberately rolled out, users cannot complete a new link through the public site. This branch does not change the running bot, apply migrations, or deploy anything.
