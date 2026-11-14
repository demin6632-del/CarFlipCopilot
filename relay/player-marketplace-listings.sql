-- AUTOFLIP fixed-price player marketplace: listing foundation only.
-- Depends on vehicle_plate_registry from PR #45. This migration is additive
-- and is intentionally not executed automatically by application startup.

CREATE TABLE IF NOT EXISTS autonomous_marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_uid uuid NOT NULL,
  seller_chat_id text NOT NULL,
  asking_price bigint NOT NULL CHECK (asking_price > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'sold', 'cancelled', 'expired')),
  vehicle_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sold_to_chat_id text,
  sold_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autonomous_marketplace_listing_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT autonomous_marketplace_listing_sale_fields
    CHECK ((status = 'sold' AND sold_to_chat_id IS NOT NULL AND sold_at IS NOT NULL)
        OR status <> 'sold')
);

CREATE UNIQUE INDEX IF NOT EXISTS autonomous_marketplace_one_active_listing_per_vehicle
  ON autonomous_marketplace_listings(vehicle_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS autonomous_marketplace_active_browse_idx
  ON autonomous_marketplace_listings(created_at DESC, asking_price ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS autonomous_marketplace_seller_status_idx
  ON autonomous_marketplace_listings(seller_chat_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS autonomous_marketplace_expiry_idx
  ON autonomous_marketplace_listings(expires_at)
  WHERE status = 'active';

COMMENT ON TABLE autonomous_marketplace_listings IS
  'Fixed-price player-to-player vehicle listings. Listing creation/cancellation only; settlement is a later phase.';
COMMENT ON COLUMN autonomous_marketplace_listings.vehicle_snapshot IS
  'Sanitized display snapshot only. Authoritative vehicle data remains in autonomous_game_state and vehicle_plate_registry.';
