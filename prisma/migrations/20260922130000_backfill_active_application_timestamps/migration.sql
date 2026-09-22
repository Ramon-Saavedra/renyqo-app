UPDATE "applications"
SET "active_at" = "created_at"
WHERE "status" = 'active'
  AND "active_at" IS NULL;
