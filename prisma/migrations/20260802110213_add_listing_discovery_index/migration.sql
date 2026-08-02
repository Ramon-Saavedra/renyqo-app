-- CreateIndex
CREATE INDEX "listings_status_published_at_id_idx" ON "listings"("status", "published_at", "id");
