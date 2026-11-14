-- Run only on the isolated Neon test branch, after vehicle-plate-registry.sql.
-- This script is self-contained and rolls back all test rows.
BEGIN;

DO $$
DECLARE
  v_uid uuid := gen_random_uuid();
  v_inserted integer;
  v_plate text := 'TESTAUTO' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
BEGIN
  -- First reservation must succeed.
  INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source)
  VALUES (v_plate, v_uid, 'registry-test-owner-a', 'integration-test');

  -- Case/whitespace variants must collide through the normalized unique key.
  INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source)
  VALUES (lower(v_plate), gen_random_uuid(), 'registry-test-owner-b', 'integration-test')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 0 THEN
    RAISE EXCEPTION 'Normalized duplicate plate was accepted';
  END IF;

  -- One physical vehicle UID must not be registered under a second plate.
  INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source)
  VALUES ('OTHER' || substr(v_plate, 5), v_uid, 'registry-test-owner-a', 'integration-test')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 0 THEN
    RAISE EXCEPTION 'Duplicate vehicle_uid was accepted';
  END IF;

  -- Ownership transfer is compare-and-set: only the current owner may transfer.
  UPDATE vehicle_plate_registry SET owner_chat_id = 'registry-test-owner-b'
  WHERE vehicle_uid = v_uid AND owner_chat_id = 'registry-test-owner-a' AND retired_at IS NULL;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'Valid vehicle ownership transfer failed';
  END IF;

  UPDATE vehicle_plate_registry SET owner_chat_id = 'registry-test-owner-c'
  WHERE vehicle_uid = v_uid AND owner_chat_id = 'registry-test-owner-a' AND retired_at IS NULL;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 0 THEN
    RAISE EXCEPTION 'Ownership transfer accepted an incorrect source owner';
  END IF;

  -- A vehicle removed from circulation must be retired under its current owner.
  UPDATE vehicle_plate_registry SET retired_at = now()
  WHERE vehicle_uid = v_uid AND owner_chat_id = 'registry-test-owner-b' AND retired_at IS NULL;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'Vehicle retirement failed';
  END IF;

  INSERT INTO vehicle_plate_registry(plate, vehicle_uid, owner_chat_id, source)
  VALUES (v_plate, gen_random_uuid(), 'registry-test-owner-c', 'integration-test')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 0 THEN
    RAISE EXCEPTION 'Retired plate was reused';
  END IF;
END $$;

ROLLBACK;
