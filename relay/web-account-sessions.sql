-- Additive migration. Do not apply automatically to production.
CREATE TABLE IF NOT EXISTS autonomous_web_sessions (
  session_hash char(64) PRIMARY KEY,
  telegram_user_id text NOT NULL
    REFERENCES autonomous_telegram_account_links(telegram_user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT autonomous_web_sessions_hash_chk CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT autonomous_web_sessions_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS autonomous_web_sessions_expiry_idx
  ON autonomous_web_sessions(expires_at);
CREATE INDEX IF NOT EXISTS autonomous_web_sessions_user_idx
  ON autonomous_web_sessions(telegram_user_id, created_at DESC);

-- Atomic rolling-window throttle for signed Mini App session issuance.
CREATE TABLE IF NOT EXISTS autonomous_web_session_rate_limits (
  telegram_user_id text PRIMARY KEY
    REFERENCES autonomous_telegram_account_links(telegram_user_id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1,
  CONSTRAINT autonomous_web_session_rate_limits_attempts_chk CHECK (attempts >= 1)
);

CREATE INDEX IF NOT EXISTS autonomous_web_session_rate_limits_window_idx
  ON autonomous_web_session_rate_limits(window_started_at);
