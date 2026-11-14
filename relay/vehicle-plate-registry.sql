-- AUTOFLIP global vehicle plate registry.
-- This file is intentionally NOT executed automatically. Apply only after the
-- isolated Neon migration test and an approved production rollout.
--
-- A plate is never recycled: retired rows remain in this table permanently.
-- vehicle_uid identifies one physical in-game vehicle across ownership changes.
-- Historical plate-only imports may leave vehicle_uid and owner_chat_id NULL.

CREATE TABLE IF NOT EXISTS vehicle_plate_registry (
  plate text PRIMARY KEY,
  plate_key text GENERATED ALWAYS AS (
    upper(regexp_replace(btrim(plate), '[[:space:]]+', '', 'g'))
  ) STORED,
  vehicle_uid uuid UNIQUE,
  owner_chat_id text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  source text NOT NULL DEFAULT 'application',
  CONSTRAINT vehicle_plate_registry_plate_not_blank
    CHECK (length(btrim(plate)) > 0),
  CONSTRAINT vehicle_plate_registry_retirement_after_issue
    CHECK (retired_at IS NULL OR retired_at >= issued_at)
);

-- Prevent formatting variants (for example, embedded spaces or lowercase)
-- from being registered as different plates.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_plate_registry_plate_key_uidx
  ON vehicle_plate_registry (plate_key);

-- Fast lookup of the currently assigned plates for one owner.
CREATE INDEX IF NOT EXISTS vehicle_plate_registry_active_owner_idx
  ON vehicle_plate_registry (owner_chat_id)
  WHERE retired_at IS NULL;

COMMENT ON TABLE vehicle_plate_registry IS
  'Permanent global registry of AUTOFLIP vehicle registration plates. Retired plates are never deleted or reissued.';
COMMENT ON COLUMN vehicle_plate_registry.vehicle_uid IS
  'Stable UUID of the physical in-game vehicle; remains unchanged when ownership changes.';
COMMENT ON COLUMN vehicle_plate_registry.retired_at IS
  'NULL while the plate is assigned; set once the vehicle leaves circulation. Retired plate rows must be retained.';
COMMENT ON COLUMN vehicle_plate_registry.plate_key IS
  'Whitespace-insensitive uppercase key used to enforce global plate uniqueness.';
