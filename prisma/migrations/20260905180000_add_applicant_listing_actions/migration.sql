CREATE TYPE "ListingReportReason" AS ENUM (
  'misleading_info',
  'scam_or_fraud',
  'discrimination',
  'inappropriate_content',
  'duplicate_or_spam',
  'other'
);

CREATE TABLE "saved_listings" (
  "id" UUID NOT NULL,
  "applicant_id" UUID NOT NULL,
  "listing_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "saved_listings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "listing_reports" (
  "id" UUID NOT NULL,
  "reporter_applicant_id" UUID,
  "listing_id" UUID NOT NULL,
  "reason" "ListingReportReason" NOT NULL,
  "detail" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "listing_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_listings_applicant_id_listing_id_key" ON "saved_listings"("applicant_id", "listing_id");

CREATE INDEX "saved_listings_applicant_id_created_at_idx" ON "saved_listings"("applicant_id", "created_at");

CREATE UNIQUE INDEX "listing_reports_reporter_applicant_id_listing_id_key" ON "listing_reports"("reporter_applicant_id", "listing_id");

CREATE INDEX "listing_reports_listing_id_created_at_idx" ON "listing_reports"("listing_id", "created_at");

ALTER TABLE "saved_listings" ADD CONSTRAINT "saved_listings_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_listings" ADD CONSTRAINT "saved_listings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "listing_reports" ADD CONSTRAINT "listing_reports_reporter_applicant_id_fkey" FOREIGN KEY ("reporter_applicant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "listing_reports" ADD CONSTRAINT "listing_reports_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
