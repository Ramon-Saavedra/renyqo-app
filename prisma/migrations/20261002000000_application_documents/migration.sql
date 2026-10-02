CREATE TYPE "ApplicationDocumentType" AS ENUM ('schufa', 'income_proof', 'identity_document', 'liability_insurance', 'other');

CREATE TYPE "ApplicationDocumentState" AS ENUM ('processing', 'available', 'failed');



ALTER TYPE "ApplicationActivityType" ADD VALUE 'document_requested';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'document_uploaded';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'document_reviewed';

CREATE TABLE "application_document_requests" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "type" "ApplicationDocumentType" NOT NULL,
    "custom_label" VARCHAR(100),
    "logical_key" VARCHAR(120) NOT NULL,
    "round" INTEGER NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),
    "current_file_id" UUID,

    CONSTRAINT "application_document_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_document_files" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "version_id" TEXT,
    "etag" TEXT,
    "checksum" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "state" "ApplicationDocumentState" NOT NULL DEFAULT 'processing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recover_after" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "available_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "scan_verdict" TEXT,
    "failure_reason" TEXT,

    CONSTRAINT "application_document_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_document_requests_current_file_id_key" ON "application_document_requests"("current_file_id");

CREATE INDEX "application_document_requests_application_id_requested_at_i_idx" ON "application_document_requests"("application_id", "requested_at", "id");

CREATE UNIQUE INDEX "application_document_requests_application_id_logical_key_ro_key" ON "application_document_requests"("application_id", "logical_key", "round");

CREATE UNIQUE INDEX "application_document_files_storage_key_key" ON "application_document_files"("storage_key");

CREATE INDEX "application_document_files_state_recover_after_id_idx" ON "application_document_files"("state", "recover_after", "id");

CREATE INDEX "application_document_files_request_id_created_at_id_idx" ON "application_document_files"("request_id", "created_at", "id");

ALTER TABLE "application_document_requests" ADD CONSTRAINT "application_document_requests_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "application_document_requests" ADD CONSTRAINT "application_document_requests_current_file_id_fkey" FOREIGN KEY ("current_file_id") REFERENCES "application_document_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "application_document_files" ADD CONSTRAINT "application_document_files_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "application_document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "document_requests_current_key" ON "application_document_requests" ("application_id", "logical_key") WHERE "superseded_at" IS NULL;
CREATE UNIQUE INDEX "document_files_successful_request" ON "application_document_files" ("request_id") WHERE "available_at" IS NOT NULL;
ALTER TABLE "application_document_requests" ADD CONSTRAINT "document_request_positive_round" CHECK ("round" > 0);
ALTER TABLE "application_document_files" ADD CONSTRAINT "document_file_size_limit" CHECK ("size" > 0 AND "size" <= 10485760);
