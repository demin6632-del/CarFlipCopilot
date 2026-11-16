# AUTOFLIP player marketplace settlement

This branch contains the fixed-price player-to-player marketplace purchase flow,
including the Telegram confirmation UI, atomic PostgreSQL settlement, and
scheduled expiry cleanup. It remains a draft review branch: it is not merged,
not deployed, and not connected to the live Telegram bot.

## Dependency and migration order

1. PR #45: global `vehicle_plate_registry` and compare-and-set ownership transfer.
2. PR #49: `autonomous_marketplace_listings`, listing creation/cancellation,
   browse queries, and the vehicle lock stored in player state.
3. PR #46: shared callback idempotency and append-only economy ledger.
4. PR #50 / this branch: `player-marketplace-settlement.sql`, which adds
   `autonomous_marketplace_transactions` and repeats the callback/ledger
   definitions as idempotent compatibility setup.
5. PR #51: Telegram purchase confirmation and expiry scheduler wiring.

The game startup currently creates `autonomous_processed_callbacks` and
`autonomous_economy_ledger` (including the append-only ledger trigger). The
settlement migration also declares those same tables, indexes, and trigger
idempotently. Before release, keep one canonical schema owner and document the
exact rollout order; do not treat duplicate `IF NOT EXISTS` statements as a
substitute for reviewing existing production schema and trigger definitions.

Apply SQL only to a disposable test database during development. Production
migration requires reviewed dependency changes, a verified backup and restore
path, an approved maintenance window, and explicit release authorization.
The bot does not automatically apply the marketplace SQL migrations.

## Telegram purchase flow

- The public listing view does not expose the seller's Telegram ID.
- A buyer opens a separate confirmation screen showing the current listing
  price, their balance, and available garage capacity.
- No money or vehicle changes before the explicit confirmation callback.
- The callback includes the confirmed price and Telegram callback ID. The
  service rechecks the expected price inside the transaction and claims the
  callback receipt atomically.
- A replayed callback cannot debit the buyer or transfer the vehicle twice.
- Buyer and seller notifications are sent only after database commit. A
  Telegram delivery failure cannot roll back or misreport a committed trade.
- If the COMMIT acknowledgement is lost, the service releases the original
  connection and checks the durable callback receipt, settlement record,
  sold listing, buyer garage, and active registry ownership through a fresh
  connection. If the outcome cannot be verified, the bot warns the player not
  to retry blindly and to check their garage and balance first.

## Atomic purchase behavior

`purchaseMarketplaceListing(pool, { buyerChatId, listingId, expectedPrice, callbackId })`
performs one fixed-price purchase:

- previews seller identity, then locks buyer and seller state rows in ascending
  `chat_id` order;
- locks and revalidates the listing after player locks;
- uses PostgreSQL's `now()` result for expiry validation (not the application
  server clock);
- claims the Telegram callback receipt in the same transaction;
- checks active/expiry status, expected price, self-purchase, safe balances,
  seller balance overflow, garage capacity, duplicate vehicle ownership, and
  the seller's matching listing lock;
- transfers global registry ownership with compare-and-set while preserving
  the vehicle UID and plate;
- moves the complete vehicle object between garages and removes the listing lock;
- debits buyer and credits seller, writes two immutable economy ledger entries,
  updates both JSON states, marks the listing sold, and inserts one immutable
  settlement history row;
- commits everything together or rolls everything back.

The lock order is player state rows (sorted), listing row, then registry row.
Listing creation, cancellation, and expiry cleanup follow the compatible
player-state-before-listing order. Listing creation locks the active listing
before the registry row to avoid a create-versus-purchase deadlock.

## Expiry cleanup

A single polling-lock owner starts the in-process expiry scheduler after it
acquires Telegram polling ownership. It runs an initial cleanup and then checks
every five minutes in batches of up to 50 listings. Overlapping ticks are
skipped; errors are logged; the scheduler stops when the polling lock is
released. It does not create a separate Render cron service.

The expiry worker rechecks and locks player state before the listing row,
unlocks the seller's vehicle, and marks the listing expired atomically. Purchase,
seller cancellation, and expiry races are covered by PostgreSQL integration
tests. If the marketplace table has not been installed, the worker safely
skips instead of taking down the bot.

## Deliberate limitations

- Fixed-price purchases only; no fee is charged (`fee_amount=0`).
- No escrow, auctions, shipping, currency conversion, or refunds.
- No public Mini App or website marketplace UI is implemented by this change.
- No marketplace migration has been applied to a live database.
- No Render deployment or live Telegram bot wiring has been changed.
- This work does not include the deferred 3D-game stage.

## Required release checks

Use a disposable PostgreSQL database and run the full CI suite. It currently
applies the registry, listing, and settlement SQL migrations, reapplies the
settlement migration to check idempotency, and runs the PostgreSQL integration
suites. Keep coverage for: two buyers racing for one listing, same callback
replay, distinct callbacks racing, cancellation race, expiry race, self-purchase,
insufficient balance, full garage, seller missing the locked vehicle, registry
owner/plate mismatch, rollback after registry transfer, lost COMMIT
acknowledgement recovery, immutable ledger/history, and exact reconciliation
of both account balances with ledger rows.

Do not merge, deploy, apply production SQL, or connect this flow to the live
bot until the complete dependency chain is reviewed and explicitly approved.
