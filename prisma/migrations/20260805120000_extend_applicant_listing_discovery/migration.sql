ALTER TABLE "listings" ADD COLUMN "district" TEXT;

CREATE INDEX "listings_status_cold_rent_id_idx" ON "listings" ("status", "cold_rent", "id");

CREATE INDEX "listings_status_living_area_id_idx" ON "listings" ("status", "living_area", "id");

CREATE INDEX "listings_status_available_from_idx" ON "listings" ("status", "available_from");
