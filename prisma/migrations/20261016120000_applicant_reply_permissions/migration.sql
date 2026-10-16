ALTER TABLE "application_conversations" ADD COLUMN "applicant_replies_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TYPE "ApplicationActivityType" ADD VALUE 'applicant_replies_enabled';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'applicant_replies_disabled';
