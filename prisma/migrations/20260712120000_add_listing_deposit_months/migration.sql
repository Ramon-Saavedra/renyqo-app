ALTER TABLE "listings"
  ADD COLUMN "deposit_months" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "listings"
  ADD CONSTRAINT "listings_deposit_months_check"
  CHECK ("deposit_months" IN (1, 2, 3));
