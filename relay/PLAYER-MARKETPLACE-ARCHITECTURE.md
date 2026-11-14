# AUTOFLIP — Global Player-to-Player Vehicle Marketplace

Status: architecture proposal only. No production schema or player data is changed by this document.

## Why this is a separate system

The current `state.market` is generated inside each player's game state. It is not a shared exchange: a car shown to one player is not a listing owned by another player. The new player marketplace must be backed by shared PostgreSQL rows and must not silently replace or break the existing market.

This feature is separate from simulated retail/customer flows already present in the game. Player-to-player competition and listings must involve real player accounts only; do not create fake player sellers or AI competitors.

## Dependencies and rollout order

1. Complete review and approved rollout of draft PR #45, which introduces the global vehicle plate registry and stable `vehicleUid`.
2. Confirm that every active vehicle has exactly one registry row with its current owner and that retired plates/vehicles cannot be reactivated accidentally.
3. Implement the marketplace in a separate migration/feature branch. It must use the registry's explicit `transferVehicleOwner(client, vehicleUid, fromOwnerChatId, toOwnerChatId)` operation inside the same PostgreSQL transaction as both player-state updates.
4. Run PostgreSQL integration tests on disposable PostgreSQL 16.
5. Back up production, schedule a maintenance window, and obtain explicit approval before any production migration or deployment.

Do not deploy marketplace code while the required registry schema is absent.

## Proposed tables

### `autonomous_marketplace_listings`

- `id uuid PRIMARY KEY`
- `vehicle_uid uuid NOT NULL` — references the global vehicle registry's unique vehicle identity
- `seller_chat_id text NOT NULL`
- `asking_price bigint NOT NULL CHECK (asking_price > 0)`
- `status text NOT NULL CHECK (status IN ('active','sold','cancelled','expired'))`
- `vehicle_snapshot jsonb NOT NULL` — display snapshot only; authoritative ownership and current vehicle state remain in player state + registry
- `created_at timestamptz NOT NULL DEFAULT now()`
- `expires_at timestamptz NOT NULL`
- `sold_to_chat_id text`
- `sold_at timestamptz`
- `updated_at timestamptz NOT NULL DEFAULT now()`

Indexes:
- Partial unique index on `vehicle_uid WHERE status='active'`: one active listing per physical vehicle.
- Partial browse index for active listings ordered by creation time and price.
- Index on seller and status for the seller's listings.
- Optional expiry index for a future cleanup worker; expired listings must also be rejected at purchase time even if cleanup has not run.

### `autonomous_marketplace_transactions`

Append-only sale record:
- `id uuid PRIMARY KEY`
- `listing_id uuid NOT NULL UNIQUE`
- `vehicle_uid uuid NOT NULL`
- `seller_chat_id text NOT NULL`
- `buyer_chat_id text NOT NULL`
- `gross_amount bigint NOT NULL CHECK (gross_amount > 0)`
- `fee_amount bigint NOT NULL CHECK (fee_amount >= 0)`
- `seller_net_amount bigint NOT NULL CHECK (seller_net_amount >= 0)`
- `completed_at timestamptz NOT NULL DEFAULT now()`

A database trigger should reject UPDATE and DELETE, matching the immutable economy-ledger approach. This table is a business audit record; the existing economy ledger remains the financial ledger.

## Listing creation

Within one transaction:
1. Lock the seller's `autonomous_game_state` row with `FOR UPDATE`.
2. Validate that the requested vehicle exists in the seller's garage, has a valid `vehicleUid` and plate, and is not already listed.
3. Reject vehicles with incomplete/invalid ownership registry data. Never repair ownership by guessing.
4. Copy a sanitized display snapshot, not a second authoritative vehicle record.
5. Insert an active listing with a positive integer price and a bounded expiry.
6. Commit. The vehicle stays in the seller's garage while listed but is marked unavailable for local sale, transfer, or destructive garage operations until the listing is cancelled or completed.

A single physical vehicle must never be simultaneously offered in the shared marketplace and sold through a second route.

## Purchase and settlement

The purchase is one atomic PostgreSQL transaction; there is no intermediate state in which money is deducted but the car is not transferred.

1. Begin transaction and claim the buyer's durable Telegram callback receipt.
2. Lock the listing row with `SELECT ... FOR UPDATE`; require `status='active'`, not expired, and buyer different from seller.
3. Lock seller and buyer state rows in deterministic `chat_id` order to avoid deadlocks.
4. Revalidate the seller's garage contains the same `vehicleUid` and plate from the listing; reject stale snapshots or missing vehicles.
5. Check buyer balance, garage capacity, and account restrictions.
6. Calculate any disclosed fee using one server-side policy. Do not accept fee/price values from callback data.
7. Call the registry's explicit owner-transfer helper in this transaction. It must compare the expected current owner; it must not silently overwrite ownership.
8. Remove the car from the seller's garage and add the exact same vehicle object to the buyer's garage, preserving `vehicleUid`, plate, VIN, history, mileage, condition, and modifications.
9. Debit the buyer and credit the seller net proceeds through `addTx` (or the project's equivalent transaction writer), then persist both economy ledgers in this same transaction.
10. Mark the listing sold and insert the immutable marketplace transaction row.
11. Commit. Any error rolls back listing status, both player states, registry owner, and both ledgers together.

The listing row lock plus its status transition ensures that two buyers racing for one listing cannot both purchase it. The durable callback receipt handles Telegram re-delivery; the listing state and unique transaction row remain the final business-level guard even if a buyer retries with a different callback.

## Cancellation and expiry

- Only the current seller may cancel an active listing.
- Cancellation locks the listing and seller state, verifies the vehicle is still present, marks the listing cancelled, and unlocks the car for ordinary garage actions.
- Expiry is a state transition to `expired`; purchase must independently check `expires_at` and reject expired listings.
- Sold/cancelled/expired rows are retained for audit. Never delete a listing to make its history disappear.
- A listing must not be reactivated by editing its status. Re-listing creates a new listing row after checking current registry ownership.

## Required safeguards

- Listing IDs and vehicle UIDs are server-generated UUIDs.
- All prices and balances are integer minor units (whole in-game rubles); reject NaN, fractional, zero, negative, or unsafe values.
- Never trust seller ID, buyer ID, price, owner, plate, or vehicle snapshot supplied by Telegram callback data.
- Every financial mutation and ownership transfer is transactional.
- Use deterministic row-lock ordering for multi-player state updates.
- Prevent garage sale, vehicle deletion, transfer, or dismantling while a vehicle has an active listing.
- Do not allow a seller to buy their own listing.
- Do not allow a buyer with a full garage or insufficient balance to alter the listing.
- Keep an immutable transaction/audit trail and record fee separately.
- Do not add AI sellers, fake players, or simulated player listings.
- Existing player balances and old per-player markets must remain unchanged during rollout.

## Integration test matrix

Run against disposable PostgreSQL 16:
- Seller lists a valid owned vehicle; listing appears to another real player.
- Listing a missing vehicle, foreign-owned vehicle, malformed UID, invalid price, or already-listed vehicle is rejected.
- Two buyers purchase the same listing concurrently: exactly one succeeds, one car transfer occurs, and exactly one buyer debit/seller credit pair is recorded.
- Duplicate callback delivered concurrently: one settlement only.
- Retry with a different callback after sale: listing status prevents a second settlement.
- Cancellation races with purchase: exactly one terminal transition wins.
- Expired listing cannot be purchased even before an expiry worker runs.
- Insufficient balance and full garage leave both players, listing, registry, and ledgers unchanged.
- Self-purchase is rejected.
- Registry transfer preserves the vehicle UID and plate and changes only the owner.
- Simulate a failure after registry transfer and before final commit: the entire transaction rolls back.
- Seller cannot locally sell, remove, dismantle, or transfer a vehicle while it is actively listed.
- Fee, seller net proceeds, buyer debit, and immutable records reconcile exactly.

## Not included in the first release

- Auctions, bids, escrow, installment payments, cross-currency exchange, delivery/shipping, dealer storefronts, price feeds, and public API access.
- These can be added after fixed-price player listings and atomic settlement are proven safe.

## Operational safety

- Schema migrations are additive and idempotent.
- No global player reset.
- No production writes, migration, or Render deployment without a verified backup, maintenance window, and explicit owner approval.
- Keep this feature in a draft PR until code review, integration tests, and dependency PR #45 rollout are complete.
