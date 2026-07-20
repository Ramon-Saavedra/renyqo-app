ALTER TABLE "applications"
ADD COLUMN "queue_order" BIGSERIAL NOT NULL;

CREATE INDEX "applications_listing_id_status_queue_order_idx"
ON "applications"("listing_id", "status", "queue_order");
