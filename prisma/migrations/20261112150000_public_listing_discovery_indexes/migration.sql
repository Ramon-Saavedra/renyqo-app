CREATE INDEX "public_listing_projections_published_at_id_idx"
  ON "public_listing_projections"("published_at", "id");
CREATE INDEX "public_listing_projections_cold_rent_id_idx"
  ON "public_listing_projections"("cold_rent", "id");
CREATE INDEX "public_listing_projections_living_area_id_idx"
  ON "public_listing_projections"("living_area", "id");
CREATE INDEX "public_listing_projections_available_from_idx"
  ON "public_listing_projections"("available_from");
