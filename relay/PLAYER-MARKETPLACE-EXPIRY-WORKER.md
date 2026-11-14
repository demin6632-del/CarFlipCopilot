# AUTOFLIP marketplace expiry worker

This is a one-shot maintenance command. It expires active marketplace listings whose
`expires_at` timestamp has passed and unlocks the corresponding vehicle in the
seller's saved game state in the same database transaction.

## Important safety conditions

- This worker is **not started by the Telegram bot** and is not scheduled by this PR.
- Do not run it against production until PR #45 (global vehicle registry) and the
  marketplace schema from this PR have been reviewed, merged in the correct order,
  and their migrations have been deliberately applied.
- The worker does not create tables or run migrations. It checks that
  `autonomous_marketplace_listings` exists and exits with an error if it does not.
- It does not transfer vehicles, debit or credit balances, or settle purchases.
- Use the same trusted `DATABASE_URL` configuration as the application. Never put
  database credentials in command-line arguments, source files, or logs.

## Manual invocation

From the `relay` directory, after the required schema is installed:

```sh
npm run marketplace:expire
```

Optional batch limit:

```sh
MARKETPLACE_EXPIRY_BATCH_SIZE=100 npm run marketplace:expire
```

The batch size must be an integer from 1 to 500; the default is 50. The process
handles one batch and exits. A scheduler can invoke it periodically after a
separate deployment/operations review.

## Suggested future schedule

A five-minute cadence is a reasonable starting point once the feature is approved,
but this document does not create a Render Cron Job or change the running service.
Before scheduling, verify migration order, database backup/restore readiness,
worker logs, and alerting for repeated failures.
