BEGIN;

-- Queue writers must use the sequence allocator before this migration is run.
-- Exclude writers while diagnosing/repairing data and installing the invariant.
LOCK TABLE applications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE listing_events, application_activities IN SHARE MODE;

CREATE TEMP TABLE queue_repair_listings ON COMMIT DROP AS
SELECT DISTINCT a.listing_id
FROM applications a
WHERE a.status = 'waiting' AND (
  a.queue_order IN (
    SELECT queue_order FROM applications GROUP BY queue_order HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM listing_events e
    WHERE e.application_id = a.id AND e.type = 'restored_by_provider'
  ) OR EXISTS (
    SELECT 1 FROM application_activities x
    WHERE x.application_id = a.id AND x.type = 'application_restored'
  )
);

-- Creation time is NOT restoration time. Require retained provenance for every
-- waiting entry in an affected listing; absent/contradictory history fails closed.
CREATE TEMP TABLE queue_repair_entries ON COMMIT DROP AS
SELECT a.id, a.listing_id,
  CASE
    WHEN latest_restore.payload->>'toStatus' = 'WAITING'
      AND latest_restore.occurred_at >= a.created_at
      THEN latest_restore.occurred_at
    WHEN latest_restore.id IS NULL
      AND NOT EXISTS (SELECT 1 FROM application_activities x
        WHERE x.application_id = a.id AND x.type = 'application_restored')
      AND EXISTS (SELECT 1 FROM application_activities x
        WHERE x.application_id = a.id AND x.type = 'application_submitted'
          AND x.payload->>'initialStatus' = 'WAITING')
      THEN a.created_at
    ELSE NULL
  END AS entered_at
FROM applications a
JOIN queue_repair_listings affected ON affected.listing_id = a.listing_id
LEFT JOIN LATERAL (
  SELECT e.id, e.payload, e.occurred_at
  FROM listing_events e
  WHERE e.application_id = a.id AND e.type = 'restored_by_provider'
    AND e.source = 'provider'
  ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
) latest_restore ON true
WHERE a.status = 'waiting';

DO $$
DECLARE ambiguous text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO ambiguous
  FROM queue_repair_entries WHERE entered_at IS NULL;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'Queue repair cannot reconstruct WAITING entry order for applications: %', ambiguous
      USING HINT = 'Inspect retained submission/restoration history. Resolve ambiguous priority explicitly before rerunning; no application status or consideration order has been changed.';
  END IF;
END $$;

-- Never rewind: nextval/setval are not rolled back. Harmless gaps are retained.
DO $$
DECLARE sequence_name text; high_water bigint; persisted_max bigint;
BEGIN
  sequence_name := pg_get_serial_sequence('applications', 'queue_order');
  EXECUTE format('SELECT last_value FROM %s', sequence_name) INTO high_water;
  SELECT COALESCE(max(queue_order), 0) INTO persisted_max FROM applications;
  PERFORM setval(sequence_name::regclass, GREATEST(high_water, persisted_max), true);
END $$;

-- Materialize assignments in deterministic queue-entry order before updating.
CREATE TEMP TABLE queue_repair_positions ON COMMIT DROP AS
SELECT id, nextval(pg_get_serial_sequence('applications', 'queue_order')) AS position
FROM (SELECT id FROM queue_repair_entries ORDER BY listing_id, entered_at, id) ordered;
UPDATE applications a SET queue_order = p.position
FROM queue_repair_positions p WHERE a.id = p.id;

-- Historical/nonwaiting collisions have no current waiting priority to recover.
-- Keep one value and give the remaining rows distinct canonical positions.
CREATE TEMP TABLE queue_history_repairs ON COMMIT DROP AS
SELECT id, nextval(pg_get_serial_sequence('applications', 'queue_order')) AS position
FROM (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY queue_order ORDER BY id) AS occurrence
    FROM applications
  ) ranked WHERE occurrence > 1 ORDER BY id
) ordered;
UPDATE applications a SET queue_order = p.position
FROM queue_history_repairs p WHERE a.id = p.id;

-- Flush deferred lifecycle checks before PostgreSQL builds an index on this table.
SET CONSTRAINTS ALL IMMEDIATE;
CREATE UNIQUE INDEX applications_queue_order_key ON applications(queue_order);
COMMIT;
