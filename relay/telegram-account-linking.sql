-- Additive schema only. This migration is intentionally not applied automatically.
CREATE TABLE IF NOT EXISTS autonomous_telegram_account_links (
  telegram_user_id text PRIMARY KEY,
  private_chat_id text NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autonomous_telegram_account_links_telegram_id_chk CHECK (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  CONSTRAINT autonomous_telegram_account_links_private_chat_chk CHECK (private_chat_id ~ '^[1-9][0-9]{0,19}$')
);

CREATE TABLE IF NOT EXISTS autonomous_telegram_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT autonomous_telegram_link_challenges_telegram_id_chk CHECK (telegram_user_id ~ '^[1-9][0-9]{0,19}$')
);

CREATE INDEX IF NOT EXISTS autonomous_telegram_link_challenges_user_created_idx
  ON autonomous_telegram_link_challenges(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autonomous_telegram_link_challenges_expiry_idx
  ON autonomous_telegram_link_challenges(expires_at)
  WHERE used_at IS NULL;
