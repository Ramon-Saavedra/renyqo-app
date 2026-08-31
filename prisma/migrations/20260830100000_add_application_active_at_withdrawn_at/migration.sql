-- AlterTable
ALTER TABLE "applications" ADD COLUMN "active_at" TIMESTAMPTZ,
ADD COLUMN "withdrawn_at" TIMESTAMPTZ;
