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
- The helper is now wired into every audited transactional write to `autonomous_game_state`, including the normal `withState()` path, initial profile creation, container-battle transactions, and street-duel transactions.
- Registry synchronization and JSONB state persistence share the same PostgreSQL transaction. A failure rolls both back.
- Active vehicles removed from a player's garage/market are retired in the registry. Explicit transfers must update registry ownership first, then reconcile both player states in the same transaction.
- This code is still gated: it must not be deployed until the schema is installed and the PostgreSQL integration test passes.

## Application integration audit

- Add a stable UUID to every vehicle object. The helper derives a repeatable
  UUID from the owner ID and existing vehicle ID for legacy cars, then persists
  it in JSONB during reconciliation.
- Reconcile every current garage and market vehicle while holding the existing
  `withState()` database transaction. Do not reserve a plate in a separate
  transaction from the state save.
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
- Keep callback idempotency and existing per-chat row locking intact. Add
  concurrency tests using two different player transactions trying to reserve
  the same candidate simultaneously.
- The audited game-state UPDATE statements now all call the registry helper before
  persisting JSONB. The read-only existing-state branch of `load()` does not
  write to the database; it is reconciled on the next transactional write.

## Rollout gates

1. Review this SQL and the backfill rules.
2. Provision a compute endpoint on the isolated Neon test branch only if it is
   available at no additional cost; otherwise run the migration in a disposable
   local PostgreSQL test environment.
3. Test fresh schema creation, repeated migration, normalized collisions,
   concurrent allocation, vehicle ownership transfer, vehicle retirement, and
   rollback after a simulated state-save failure.
4. Add application integration and tests on a feature branch.
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
- `open()` calls `load()` outside `withState()`; therefore the first-screen
  and legacy-normalization paths must also be handled safely before global
  allocation is enabled.
- Vehicle IDs such as `car_<turn>_<sequence>` are only local to one player.
  They cannot be used alone as a global vehicle identity.
