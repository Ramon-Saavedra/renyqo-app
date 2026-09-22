ALTER TABLE "listings" ADD COLUMN "display_order" INTEGER;

WITH numbered_listings AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "provider_id"
      ORDER BY "created_at" DESC, "id" DESC
    )::INTEGER AS "display_order"
  FROM "listings"
)
UPDATE "listings" AS listings
SET "display_order" = numbered_listings."display_order"
FROM numbered_listings
WHERE listings."id" = numbered_listings."id";

ALTER TABLE "listings" ALTER COLUMN "display_order" SET NOT NULL;

CREATE UNIQUE INDEX "listings_provider_id_display_order_key"
ON "listings"("provider_id", "display_order");

CREATE INDEX "listings_provider_id_display_order_id_idx"
ON "listings"("provider_id", "display_order", "id");
