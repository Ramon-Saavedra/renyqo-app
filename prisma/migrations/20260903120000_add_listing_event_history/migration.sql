-- CreateEnum
CREATE TYPE "ListingEventType" AS ENUM ('rejected_by_provider', 'restored_by_provider');

-- CreateEnum
CREATE TYPE "ListingEventSource" AS ENUM ('system', 'provider', 'applicant');

-- CreateTable
CREATE TABLE "listing_events" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "application_id" UUID,
    "type" "ListingEventType" NOT NULL,
    "source" "ListingEventSource" NOT NULL,
    "actor_user_id" UUID,
    "reason" TEXT,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_events_listing_id_occurred_at_idx" ON "listing_events"("listing_id", "occurred_at");

-- CreateIndex
CREATE INDEX "listing_events_application_id_occurred_at_idx" ON "listing_events"("application_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
