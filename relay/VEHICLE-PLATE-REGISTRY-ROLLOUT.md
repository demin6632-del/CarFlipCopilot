# Global vehicle plate registry rollout

## Status

Schema draft only. This migration has **not** been run against Neon production or the
isolated test branch. It is not wired into application startup and does not change
player data.

## Registry invariants

1. A normalized plate is globally unique. The database enforces this with
   `plate_key`, not an in-memory per-player set.
2. A plate is permanent. Retired rows are retained and must never be deleted or
   selected for a new vehicle.
3. `vehicle_uid` identifies the physical in-game vehicle and remains stable when
   the vehicle changes owner.
4. A vehicle leaving circulation is marked retired; the plate is not released.
5. A player-to-player transfer changes `owner_chat_id`, not the plate or
   `vehicle_uid`.
6. Legacy historical plates can be imported as retired rows with a NULL
   `vehicle_uid`. This reserves them without pretending they identify a current
   vehicle.

## Helper implementation status

- `vehicle-plate-registry.js` now contains an isolated transactional reservation helper.
- `vehicle-plate-registry.test.js` covers normalization, stable IDs, repeat reconciliation, foreign collisions, retired numbers, and local duplicates.
- The helper is now wired into every audited transactional write to `autonomous_game_state`, including `load()` (existing and new profiles), `save()`, the normal `withState()` path, container-battle transactions, and street-duel transactions.
- Registry synchronization and JSONB state persistence share the same PostgreSQL transaction. A failure rolls both back.
- Active vehicles removed from a player's garage/market are retired in the registry. Explicit transfers must update registry ownership first, then reconcile both player states in the same transaction.
- GitHub Actions now passes the schema and application-helper integration tests on a disposable PostgreSQL 16 service. This is not a production migration: the code must not be deployed until the schema is installed through an approved rollout.

## Application integration audit

- Add a stable UUID to every vehicle object. The helper derives a repeatable
  UUID from the owner ID and existing vehicle ID for legacy cars, then persists
  it in JSONB during reconciliation.
- Reconcile every current garage and market vehicle while holding the player's
  PostgreSQL row lock. `load()`, `save()`, and `withState()` now run registry
  reconciliation and JSONB persistence in the same transaction.
- For a new plate, generate a candidate and attempt an INSERT. On a uniqueness
  conflict, generate another candidate and retry with a strict retry limit.
- For an existing plate, claim it only if it is not already assigned to another
  vehicle. If it is globally occupied by a different vehicle, retain the old
  value in history and assign a fresh plate.
- Update the JSONB state and registry in the same transaction. A failed state
  save must roll back the registry change too.
- When a vehicle expires or is otherwise removed from circulation, reconciliation marks its
  registry row retired in that same transaction. Do not retire a vehicle merely
  because it moves from market to garage or between players. A player-to-player
  transfer must change the registry owner before reconciling the old and new states.
- Keep callback idempotency and existing per-chat row locking intact. The
  PostgreSQL integration test now uses two concurrent player transactions to
  reserve the same candidate and verifies that the second player receives a
  different globally unique plate.
- The audited game-state UPDATE statements now all call the registry helper before
  persisting JSONB. `load()` now locks the profile row, normalizes legacy state,
  reconciles every active vehicle, persists the registry and JSONB state
  atomically, and only then returns the profile.

## Read-only production audit (2026-11-14)

The production Neon branch was inspected without changing data:

- 1 player profile.
- 1 vehicle in the garage and 4 in the market.
- All 5 active vehicles currently have no registration plate.
- No profile currently has legacy `vehiclePlatesIssued` history.
- The `vehicle_plate_registry` table does not exist yet.

This small legacy state makes the first backfill easy to review, but it still
requires a backup and an explicitly approved production migration. The audit
must be repeated immediately before rollout because live game data can change.

## Rollout gates

1. Review this SQL and the backfill rules.
2. Use the GitHub Actions PostgreSQL 16 service for isolated migration and
   application-helper integration tests. Do not provision Neon test compute
   merely to run these tests.
3. Keep the disposable CI tests passing for fresh and repeated schema creation,
   normalized collisions, concurrent allocation, vehicle ownership transfer,
   vehicle retirement, legacy-history import, and transaction rollback.
4. Review and approve the application integration and test coverage on this feature branch.
5. Back up production and verify the migration against a fresh production
   snapshot before any production change.
6. Apply to production only after the user explicitly approves the rollout.
7. Deploy the application only after the schema is ready. Verify the running
   Render commit before reporting completion.

## Important existing-code findings

- `withState()` already uses a PostgreSQL transaction and locks one player's
  `autonomous_game_state` row with `FOR UPDATE`. This is the correct place to
  coordinate the JSONB update with registry writes.
- `newState()` creates five market vehicles immediately, and `refreshMarket()`
  can create replacement listings during gameplay.
- `purchaseListing()` moves a vehicle from market to garage without changing
  its plate. `acceptPendingSale()` removes a vehicle from the garage.
- `open()` calls `load()` outside `withState()`. This is now safe because
  `load()` itself performs row-locked registry reconciliation and persistence
  before returning a profile.
- Vehicle IDs such as `car_<turn>_<sequence>` are only local to one player.
  They cannot be used alone as a global vehicle identity.
