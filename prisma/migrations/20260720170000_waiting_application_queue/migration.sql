ALTER TYPE "ApplicationStatus" RENAME VALUE 'pending_queue' TO 'waiting';

CREATE INDEX "applications_listing_id_status_created_at_idx"
ON "applications"("listing_id", "status", "created_at");

CREATE INDEX "applications_applicant_id_idx"
ON "applications"("applicant_id");
