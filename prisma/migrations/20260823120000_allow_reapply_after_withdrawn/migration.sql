-- Drop the legacy full unique index that permanently blocked re-applying after withdrawal.
DROP INDEX IF EXISTS "applications_listing_id_applicant_id_key";

-- Partial unique index: only one live (ACTIVE or WAITING) application per listing/applicant.
-- The persisted enum values for these statuses are 'active' and 'waiting'.
CREATE UNIQUE INDEX "applications_listing_id_applicant_id_status_live_idx"
ON "applications"("listing_id", "applicant_id")
WHERE "status" IN ('active', 'waiting');
