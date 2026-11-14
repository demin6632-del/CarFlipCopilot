# AUTOFLIP player marketplace settlement

This branch adds the first server-side settlement implementation for fixed-price
player-to-player vehicle listings. It is intentionally not wired into Telegram
callbacks and is not deployed.

## Dependency and migration order

1. PR #45: global `vehicle_plate_registry` and `transferVehicleOwner`.
2. PR #49: `autonomous_marketplace_listings` and listing lock in player state.
3. PR #46: economy ledger / callback idempotency behavior. This branch includes
   the exact additive tables needed by settlement in its own migration so it
   can be tested independently; schema ownership and migration consolidation
   must be reconciled before release.
4. Apply `player-marketplace-settlement.sql` only after the listing table exists.

The migration is not run automatically. Do not run it against production until
all dependency PRs are reviewed, merged in the correct order, and a backup and
maintenance window are approved.

## Atomic purchase behavior

`purchaseMarketplaceListing(pool, { buyerChatId, listingId, callbackId })`
performs one fixed-price purchase:

- previews seller identity, then locks buyer and seller state rows in ascending
  `chat_id` order;
- locks and revalidates the listing after player locks;
- claims the Telegram callback receipt in the same transaction;
- checks active/expiry status, self-purchase, funds, garage capacity, duplicate
  vehicle ownership, and the seller's matching listing lock;
- transfers global registry ownership with compare-and-set while preserving
  the vehicle UID and plate;
- moves the complete vehicle object between garages and removes the listing lock;
- debits buyer and credits seller, writes two immutable economy ledger entries,
  updates both JSON states, marks the listing sold, and inserts one settlement
  history row;
- commits everything together or rolls everything back.

The lock order is player state rows (sorted), listing row, then registry update.
Cancellation and expiry already lock seller state before listing, so they use
the same state/listing ordering.

## Deliberate limitations

- No Telegram purchase button/callback is connected.
- No seller/buyer notification flow is connected.
- No marketplace fee is charged; `fee_amount=0`.
- No escrow, auctions, shipping, currency conversion, or refunds.
- No schema migration has been applied to any live database.
- The settlement service is not called by the running bot.
- This is a draft foundation and must pass PostgreSQL concurrency integration
  tests and full CI before any release consideration.

## Required release tests

Use a disposable PostgreSQL database and test at least: two buyers racing for
one listing, same callback replay, distinct callbacks racing, cancellation race,
expiry race, self-purchase, insufficient balance, full garage, seller missing
the locked vehicle, registry owner/plate mismatch, rollback after registry
transfer, and exact reconciliation of both account balances with ledger rows.
