-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('active', 'pending_queue', 'rejected', 'withdrawn');

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'pending_queue',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applications_listing_id_applicant_id_key" ON "applications"("listing_id", "applicant_id");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
