ALTER TYPE "ApplicationStatus" ADD VALUE 'accepted';

ALTER TYPE "ListingStatus" ADD VALUE 'rented';

CREATE TYPE "ApplicationRejectionReason" AS ENUM ('not_selected', 'listing_rented');

ALTER TABLE "applications"
ADD COLUMN "rejected_at" TIMESTAMPTZ,
ADD COLUMN "public_reason" "ApplicationRejectionReason";

ALTER TABLE "listings"
ADD COLUMN "rented_at" TIMESTAMPTZ;
