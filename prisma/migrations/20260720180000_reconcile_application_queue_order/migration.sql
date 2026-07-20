WITH ordered_applications AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS queue_order
  FROM "applications"
)
UPDATE "applications" AS applications
SET "queue_order" = ordered_applications.queue_order
FROM ordered_applications
WHERE applications.id = ordered_applications.id;

SELECT setval(
  pg_get_serial_sequence('applications', 'queue_order'),
  COALESCE(MAX("queue_order"), 1),
  MAX("queue_order") IS NOT NULL
)
FROM "applications";

DROP INDEX IF EXISTS "applications_listing_id_status_created_at_idx";
