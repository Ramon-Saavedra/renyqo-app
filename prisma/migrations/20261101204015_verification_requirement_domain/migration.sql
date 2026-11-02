-- Run with document/application writers stopped. The entire migration is atomic.
BEGIN;
LOCK TABLE applications, application_document_requests, application_document_files IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE invalid text;
BEGIN
  SELECT string_agg(r.id::text, ', ' ORDER BY r.id) INTO invalid
    FROM application_document_requests r JOIN application_document_files f ON f.id=r.current_file_id WHERE f.request_id<>r.id;
  IF invalid IS NOT NULL THEN RAISE EXCEPTION 'Cross-request current file pointers require manual resolution: %',invalid; END IF;
  SELECT string_agg(request_id::text, ', ' ORDER BY request_id) INTO invalid FROM
    (SELECT request_id FROM application_document_files WHERE state='processing' GROUP BY request_id HAVING count(*)>1) bad;
  IF invalid IS NOT NULL THEN RAISE EXCEPTION 'Duplicate processing attempts require manual resolution for requests: %',invalid; END IF;
END $$;
DROP INDEX document_requests_current_key;
-- CreateEnum
CREATE TYPE "VerificationSubjectKind" AS ENUM ('APPLICANT', 'HOUSEHOLD_MEMBER');

-- CreateEnum
CREATE TYPE "VerificationRequirementState" AS ENUM ('OPEN', 'CANCELLED', 'SUPERSEDED', 'LEGACY_CLOSED_UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationProvenance" AS ENUM ('NATIVE', 'LEGACY');

-- CreateEnum
CREATE TYPE "VerificationCommandOperation" AS ENUM ('REQUEST', 'CANCEL', 'REPLACE');

-- AlterEnum
ALTER TYPE "ApplicationActivityType" ADD VALUE 'document_request_superseded';

-- DropForeignKey
ALTER TABLE "application_document_requests" DROP CONSTRAINT "application_document_requests_current_file_id_fkey";

-- DropIndex
DROP INDEX "application_document_requests_application_id_logical_key_ro_key";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "verification_scope_revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "application_document_requests" ADD COLUMN     "closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "closed_by_user_id" UUID,
ADD COLUMN     "closed_scope_revision" INTEGER,
ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "created_scope_revision" INTEGER,
ADD COLUMN     "lifecycle_state" "VerificationRequirementState" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "predecessor_id" UUID,
ADD COLUMN     "provenance" "VerificationProvenance" NOT NULL DEFAULT 'NATIVE',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "subject_id" UUID;

-- CreateTable
CREATE TABLE "application_verification_subjects" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "kind" "VerificationSubjectKind" NOT NULL,
    "subject_key" VARCHAR(64) NOT NULL,
    "display_label" VARCHAR(100),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provenance" "VerificationProvenance" NOT NULL DEFAULT 'NATIVE',

    CONSTRAINT "application_verification_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_command_receipts" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "operation" "VerificationCommandOperation" NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "scope_revision" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "committed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_command_receipts_pkey" PRIMARY KEY ("id")
);

-- This is an observed application association, never a reconstructed household identity.
INSERT INTO application_verification_subjects(id,application_id,kind,subject_key,provenance)
SELECT gen_random_uuid(),application_id,'APPLICANT','applicant','LEGACY'
FROM application_document_requests GROUP BY application_id;
UPDATE application_document_requests r SET subject_id=s.id, provenance='LEGACY',
  lifecycle_state=CASE WHEN r.superseded_at IS NULL THEN 'OPEN'::"VerificationRequirementState" ELSE 'LEGACY_CLOSED_UNKNOWN'::"VerificationRequirementState" END,
  closed_at=r.superseded_at AT TIME ZONE 'UTC'
FROM application_verification_subjects s WHERE s.application_id=r.application_id;
ALTER TABLE application_document_requests ALTER COLUMN subject_id SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "application_verification_subjects_application_id_subject_ke_key" ON "application_verification_subjects"("application_id", "subject_key");

-- CreateIndex
CREATE UNIQUE INDEX "application_verification_subjects_id_application_id_key" ON "application_verification_subjects"("id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_receipt_key" ON "verification_command_receipts"("application_id", "actor_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "application_document_requests_predecessor_id_key" ON "application_document_requests"("predecessor_id");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_identity_round_key" ON "application_document_requests"("application_id", "subject_id", "logical_key", "round");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_id_identity_key" ON "application_document_requests"("id", "application_id", "subject_id", "logical_key");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_predecessor_identity_key" ON "application_document_requests"("predecessor_id", "application_id", "subject_id", "logical_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_current_file_identity_key" ON "application_document_requests"("current_file_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_file_id_request_key" ON "application_document_files"("id", "request_id");

-- AddForeignKey
ALTER TABLE "application_document_requests" ADD CONSTRAINT "application_document_requests_subject_id_application_id_fkey" FOREIGN KEY ("subject_id", "application_id") REFERENCES "application_verification_subjects"("id", "application_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_document_requests" ADD CONSTRAINT "application_document_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_document_requests" ADD CONSTRAINT "application_document_requests_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_document_requests" ADD CONSTRAINT "requirement_predecessor_identity_fkey" FOREIGN KEY ("predecessor_id", "application_id", "subject_id", "logical_key") REFERENCES "application_document_requests"("id", "application_id", "subject_id", "logical_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_document_requests" ADD CONSTRAINT "document_current_file_same_request_fkey" FOREIGN KEY ("current_file_id", "id") REFERENCES "application_document_files"("id", "request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_verification_subjects" ADD CONSTRAINT "application_verification_subjects_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_verification_subjects" ADD CONSTRAINT "application_verification_subjects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_command_receipts" ADD CONSTRAINT "verification_command_receipts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_command_receipts" ADD CONSTRAINT "verification_command_receipts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX document_requests_current_key ON application_document_requests(application_id,subject_id,logical_key) WHERE lifecycle_state='OPEN';
CREATE UNIQUE INDEX document_one_processing_attempt ON application_document_files(request_id) WHERE state='processing';
ALTER TABLE applications ADD CONSTRAINT verification_scope_nonnegative CHECK(verification_scope_revision>=0);
ALTER TABLE application_verification_subjects ADD CONSTRAINT verification_subject_shape CHECK (
  (kind='APPLICANT' AND subject_key='applicant') OR
  (kind='HOUSEHOLD_MEMBER' AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
ALTER TABLE application_verification_subjects ADD CONSTRAINT verification_subject_actor CHECK(provenance='LEGACY' OR created_by_user_id IS NOT NULL);
ALTER TABLE application_document_requests ADD CONSTRAINT requirement_identity_shape CHECK((revision>0 AND (provenance='LEGACY' OR (created_by_user_id IS NOT NULL AND created_scope_revision>0))) IS TRUE);
ALTER TABLE application_document_requests ADD CONSTRAINT requirement_closure_shape CHECK ((
  (lifecycle_state='OPEN' AND closed_at IS NULL AND superseded_at IS NULL AND closed_by_user_id IS NULL AND closed_scope_revision IS NULL) OR
  (lifecycle_state='CANCELLED' AND closed_at IS NOT NULL AND superseded_at IS NULL AND closed_by_user_id IS NOT NULL AND closed_scope_revision>0) OR
  (lifecycle_state='SUPERSEDED' AND closed_at IS NOT NULL AND superseded_at IS NOT NULL AND superseded_at AT TIME ZONE 'UTC'=closed_at AND closed_by_user_id IS NOT NULL AND closed_scope_revision>0) OR
  (lifecycle_state='LEGACY_CLOSED_UNKNOWN' AND provenance='LEGACY' AND closed_at IS NOT NULL AND superseded_at IS NOT NULL AND closed_by_user_id IS NULL AND closed_scope_revision IS NULL)
) IS TRUE);
ALTER TABLE verification_command_receipts ADD CONSTRAINT verification_receipt_shape CHECK(schema_version=1 AND scope_revision>0 AND payload_hash ~ '^[0-9a-f]{64}$' AND idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$' AND jsonb_typeof(result->'requirements')='array' AND (result->>'scopeRevision')::integer=scope_revision AND result ? 'scopeRevision' AND result ? 'requirements');

CREATE FUNCTION immutable_verification_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Verification identity or receipt is immutable' USING ERRCODE='23514'; END $$;
CREATE FUNCTION guard_verification_subject_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provenance<>'NATIVE' THEN RAISE EXCEPTION 'New subjects cannot claim legacy provenance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_subject_insert BEFORE INSERT ON application_verification_subjects FOR EACH ROW EXECUTE FUNCTION guard_verification_subject_insert();
CREATE TRIGGER verification_subject_immutable BEFORE UPDATE OR DELETE ON application_verification_subjects FOR EACH ROW EXECUTE FUNCTION immutable_verification_record();
CREATE TRIGGER verification_receipt_immutable BEFORE UPDATE OR DELETE ON verification_command_receipts FOR EACH ROW EXECUTE FUNCTION immutable_verification_record();

CREATE FUNCTION guard_requirement_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous application_document_requests%ROWTYPE; scope integer; app_status "ApplicationStatus"; listing_status "ListingStatus"; evidence_only boolean := false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Requirement history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.application_id,NEW.subject_id,NEW.type,NEW.custom_label,NEW.logical_key,NEW.round,NEW.requested_at,NEW.predecessor_id,NEW.created_by_user_id,NEW.created_scope_revision,NEW.provenance) IS DISTINCT FROM
       (OLD.id,OLD.application_id,OLD.subject_id,OLD.type,OLD.custom_label,OLD.logical_key,OLD.round,OLD.requested_at,OLD.predecessor_id,OLD.created_by_user_id,OLD.created_scope_revision,OLD.provenance) OR OLD.lifecycle_state<>'OPEN' THEN
      RAISE EXCEPTION 'Requirement identity and closed history are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.lifecycle_state=OLD.lifecycle_state THEN
      IF NEW.revision<>OLD.revision THEN RAISE EXCEPTION 'Evidence does not revise requirement scope' USING ERRCODE='23514'; END IF;
      IF NEW.current_file_id IS NOT DISTINCT FROM OLD.current_file_id THEN RETURN NEW; END IF;
      IF EXISTS(SELECT 1 FROM application_document_files WHERE id=OLD.current_file_id AND available_at IS NOT NULL) THEN RAISE EXCEPTION 'Published evidence requires a new requirement round' USING ERRCODE='23514'; END IF;
      evidence_only := true;
    END IF;
    IF NOT evidence_only AND (NEW.lifecycle_state NOT IN ('CANCELLED','SUPERSEDED') OR NEW.revision<>OLD.revision+1 OR NEW.current_file_id IS DISTINCT FROM OLD.current_file_id) THEN
      RAISE EXCEPTION 'Invalid requirement closure transition' USING ERRCODE='23514';
    END IF;
  END IF;
  -- Legacy provenance is assigned only by the migration before this guard exists.
  IF TG_OP='INSERT' AND NEW.provenance='LEGACY' THEN RAISE EXCEPTION 'New requirements cannot claim legacy provenance' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM listings WHERE id=(SELECT listing_id FROM applications WHERE id=NEW.application_id) FOR UPDATE;
  SELECT a.verification_scope_revision,a.status,l.status INTO scope,app_status,listing_status FROM applications a JOIN listings l ON l.id=a.listing_id WHERE a.id=NEW.application_id FOR UPDATE OF a;
  IF app_status<>'active' OR listing_status NOT IN ('published','paused') THEN RAISE EXCEPTION 'Verification work is frozen' USING ERRCODE='23514'; END IF;
  IF evidence_only THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO previous FROM application_document_requests WHERE application_id=NEW.application_id AND subject_id=NEW.subject_id AND logical_key=NEW.logical_key ORDER BY round DESC LIMIT 1;
    IF NEW.lifecycle_state<>'OPEN' OR NEW.revision<>1 OR NEW.created_scope_revision IS DISTINCT FROM scope OR scope<1 OR
      NEW.round<>COALESCE(previous.round,0)+1 OR NEW.predecessor_id IS DISTINCT FROM previous.id OR previous.lifecycle_state='OPEN' THEN
      RAISE EXCEPTION 'Requirement round, predecessor or scope is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.closed_scope_revision IS DISTINCT FROM scope OR scope<=COALESCE(NEW.created_scope_revision,0) THEN
    RAISE EXCEPTION 'Requirement closure scope is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_write_guard BEFORE INSERT OR UPDATE OR DELETE ON application_document_requests FOR EACH ROW EXECUTE FUNCTION guard_requirement_write();

CREATE FUNCTION guard_verification_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_scope_revision<>OLD.verification_scope_revision AND NEW.verification_scope_revision<>OLD.verification_scope_revision+1 THEN
    RAISE EXCEPTION 'Scope revision must advance once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_scope_order BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION guard_verification_scope();
CREATE FUNCTION complete_verification_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_scope_revision<>OLD.verification_scope_revision AND NOT EXISTS (
    SELECT 1 FROM application_document_requests WHERE application_id=NEW.id AND (created_scope_revision=NEW.verification_scope_revision OR closed_scope_revision=NEW.verification_scope_revision)
  ) THEN RAISE EXCEPTION 'Scope revision has no committed requirement change' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER verification_scope_complete AFTER UPDATE ON applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_verification_scope();

CREATE FUNCTION complete_requirement_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state='SUPERSEDED' AND NOT EXISTS(SELECT 1 FROM application_document_requests WHERE predecessor_id=NEW.id AND created_scope_revision=NEW.closed_scope_revision) THEN
    RAISE EXCEPTION 'Supersession requires a successor in the same scope command' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER requirement_supersession_complete AFTER INSERT OR UPDATE ON application_document_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_requirement_supersession();
CREATE FUNCTION guard_verification_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_scope integer;
BEGIN
  SELECT verification_scope_revision INTO current_scope FROM applications WHERE id=NEW.application_id FOR UPDATE;
  IF NEW.scope_revision IS DISTINCT FROM current_scope OR jsonb_typeof(NEW.result->'requirements') IS DISTINCT FROM 'array' OR
     jsonb_array_length(NEW.result->'requirements') NOT BETWEEN 1 AND 20 OR
     (NEW.operation='CANCEL' AND jsonb_array_length(NEW.result->'requirements')<>1) OR
     (NEW.operation='REPLACE' AND jsonb_array_length(NEW.result->'requirements')<>2) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.result->'requirements') item WHERE NOT EXISTS (
         SELECT 1 FROM application_document_requests r WHERE r.id=(item->>'id')::uuid AND r.application_id=NEW.application_id AND
           r.revision=(item->>'revision')::integer AND r.round=(item->>'round')::integer AND r.lifecycle_state::text=(item->>'state') AND
           (r.created_scope_revision=NEW.scope_revision OR r.closed_scope_revision=NEW.scope_revision)
       )
     ) THEN RAISE EXCEPTION 'Invalid verification command result' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_receipt_result BEFORE INSERT ON verification_command_receipts FOR EACH ROW EXECUTE FUNCTION guard_verification_receipt();
COMMIT;
