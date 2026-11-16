-- AUTOFLIP marketplace settlement migration.
-- Apply only after PR #45 registry and PR #49 listing schema are installed.
-- This migration is additive and is NOT run automatically by the bot.

CREATE TABLE IF NOT EXISTS autonomous_processed_callbacks (
  chat_id text NOT NULL,
  callback_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, callback_id)
);

CREATE INDEX IF NOT EXISTS autonomous_processed_callbacks_time_idx
  ON autonomous_processed_callbacks(processed_at);

CREATE TABLE IF NOT EXISTS autonomous_economy_ledger (
  transaction_id uuid PRIMARY KEY,
  chat_id text NOT NULL,
  kind text NOT NULL,
  amount bigint NOT NULL,
  balance_after bigint NOT NULL,
  description text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomous_economy_ledger_chat_time_idx
  ON autonomous_economy_ledger(chat_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_autonomous_economy_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  RAISE EXCEPTION 'autonomous_economy_ledger is append-only';
END;
$func$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'autonomous_economy_ledger_immutable_trg'
      AND tgrelid = 'autonomous_economy_ledger'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER autonomous_economy_ledger_immutable_trg
    BEFORE UPDATE OR DELETE ON autonomous_economy_ledger
    FOR EACH ROW EXECUTE FUNCTION reject_autonomous_economy_ledger_mutation();
  END IF;
END;
$do$;

CREATE TABLE IF NOT EXISTS autonomous_marketplace_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES autonomous_marketplace_listings(id),
  vehicle_uid uuid NOT NULL,
  buyer_chat_id text NOT NULL,
  seller_chat_id text NOT NULL,
  gross_amount bigint NOT NULL CHECK (gross_amount > 0),
  fee_amount bigint NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  net_amount bigint NOT NULL CHECK (net_amount >= 0),
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autonomous_marketplace_transaction_parties
    CHECK (buyer_chat_id <> seller_chat_id),
  CONSTRAINT autonomous_marketplace_transaction_amounts
    CHECK (gross_amount = fee_amount + net_amount),
  CONSTRAINT autonomous_marketplace_one_settlement_per_listing UNIQUE (listing_id)
);

-- Completed marketplace transactions are permanent financial history.
CREATE OR REPLACE FUNCTION reject_autonomous_marketplace_transaction_mutation()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  RAISE EXCEPTION 'autonomous_marketplace_transactions is append-only';
END;
$func$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'autonomous_marketplace_transactions_immutable_trg'
      AND tgrelid = 'autonomous_marketplace_transactions'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER autonomous_marketplace_transactions_immutable_trg
    BEFORE UPDATE OR DELETE ON autonomous_marketplace_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_autonomous_marketplace_transaction_mutation();
  END IF;
END;
$do$;

CREATE INDEX IF NOT EXISTS autonomous_marketplace_transactions_buyer_time_idx
  ON autonomous_marketplace_transactions(buyer_chat_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS autonomous_marketplace_transactions_seller_time_idx
  ON autonomous_marketplace_transactions(seller_chat_id, completed_at DESC);

COMMENT ON TABLE autonomous_marketplace_transactions IS
  'Immutable settlement history for completed player-to-player vehicle purchases.';
