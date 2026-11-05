-- Immutable business decisions. They do not change requirement lifecycle or scope revision.
CREATE TYPE "VerificationDecisionOutcome" AS ENUM ('SATISFIED', 'NOT_SATISFIED', 'WAIVED');

CREATE TABLE "verification_decisions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "evidence_file_id" UUID,
    "outcome" "VerificationDecisionOutcome" NOT NULL,
    "reason" VARCHAR(500),
    "actor_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scope_revision" INTEGER NOT NULL,
    "previous_decision_id" UUID,
    "provenance" "VerificationProvenance" NOT NULL DEFAULT 'NATIVE',
    CONSTRAINT "verification_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "verification_decisions_previous_decision_id_key" ON "verification_decisions"("previous_decision_id");
CREATE UNIQUE INDEX "verification_decision_root" ON "verification_decisions"("requirement_id") WHERE "previous_decision_id" IS NULL;
CREATE INDEX "verification_decisions_application_id_decided_at_id_idx" ON "verification_decisions"("application_id", "decided_at", "id");
CREATE INDEX "verification_decisions_requirement_id_decided_at_id_idx" ON "verification_decisions"("requirement_id", "decided_at", "id");

ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "application_document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decision_evidence_fkey" FOREIGN KEY ("evidence_file_id", "requirement_id") REFERENCES "application_document_files"("id", "request_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_previous_decision_id_fkey" FOREIGN KEY ("previous_decision_id") REFERENCES "verification_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decision_shape" CHECK (
    ("outcome" = 'SATISFIED' AND "evidence_file_id" IS NOT NULL AND "reason" IS NULL)
    OR ("outcome" = 'NOT_SATISFIED' AND "evidence_file_id" IS NOT NULL AND "reason" IS NOT NULL AND char_length(btrim("reason")) > 0 AND char_length("reason") <= 500)
    OR ("outcome" = 'WAIVED' AND ("reason" IS NULL OR (char_length(btrim("reason")) > 0 AND char_length("reason") <= 500)))
);

CREATE FUNCTION immutable_verification_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Verification decisions are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER verification_decision_immutable BEFORE UPDATE OR DELETE ON verification_decisions FOR EACH ROW EXECUTE FUNCTION immutable_verification_decision();

CREATE FUNCTION guard_verification_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing_id uuid; app_status "ApplicationStatus"; listing_status "ListingStatus"; scope integer; requirement application_document_requests%ROWTYPE; evidence application_document_files%ROWTYPE;
BEGIN
  SELECT a.listing_id INTO listing_id FROM applications a WHERE a.id = NEW.application_id;
  IF listing_id IS NULL THEN RAISE EXCEPTION 'Verification decision application is missing' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM listings WHERE id = listing_id FOR UPDATE;
  SELECT a.status, a.verification_scope_revision, l.status INTO app_status, scope, listing_status
    FROM applications a JOIN listings l ON l.id = a.listing_id WHERE a.id = NEW.application_id FOR UPDATE OF a;
  IF app_status <> 'active' OR listing_status NOT IN ('published', 'paused') THEN RAISE EXCEPTION 'Verification work is frozen' USING ERRCODE = '23514'; END IF;
  IF NEW.provenance <> 'NATIVE' OR NEW.scope_revision IS DISTINCT FROM scope THEN RAISE EXCEPTION 'Verification decision scope is stale' USING ERRCODE = '23514'; END IF;
  IF NEW.actor_user_id IS DISTINCT FROM (SELECT provider_id FROM listings WHERE id = listing_id) THEN RAISE EXCEPTION 'Only the listing provider can decide verification' USING ERRCODE = '23514'; END IF;
  SELECT * INTO requirement FROM application_document_requests WHERE id = NEW.requirement_id FOR UPDATE;
  IF NOT FOUND OR requirement.application_id IS DISTINCT FROM NEW.application_id OR requirement.lifecycle_state <> 'OPEN' THEN
    RAISE EXCEPTION 'Verification decision requires an open requirement' USING ERRCODE = '23514';
  END IF;
  IF NEW.previous_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM verification_decisions previous
    WHERE previous.id = NEW.previous_decision_id AND previous.requirement_id = NEW.requirement_id AND previous.application_id = NEW.application_id
  ) THEN RAISE EXCEPTION 'Decision correction must continue the same requirement' USING ERRCODE = '23514'; END IF;
  IF NEW.outcome = 'WAIVED' THEN
    IF NEW.evidence_file_id IS NOT NULL AND NEW.evidence_file_id IS DISTINCT FROM requirement.current_file_id THEN RAISE EXCEPTION 'Waived evidence is not the current file' USING ERRCODE = '23514'; END IF;
    IF NEW.reason IS NOT NULL AND (char_length(btrim(NEW.reason)) = 0 OR char_length(NEW.reason) > 500) THEN RAISE EXCEPTION 'Waived decision reason is invalid' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.outcome IN ('SATISFIED', 'NOT_SATISFIED') THEN
    IF NEW.evidence_file_id IS NULL OR NEW.evidence_file_id IS DISTINCT FROM requirement.current_file_id THEN RAISE EXCEPTION 'Decision evidence is not the current file' USING ERRCODE = '23514'; END IF;
    SELECT * INTO evidence FROM application_document_files WHERE id = NEW.evidence_file_id;
    IF evidence.state <> 'available' OR evidence.available_at IS NULL OR evidence.request_id IS DISTINCT FROM requirement.id THEN RAISE EXCEPTION 'Decision evidence is not available' USING ERRCODE = '23514'; END IF;
    IF NEW.outcome = 'SATISFIED' AND NEW.reason IS NOT NULL THEN RAISE EXCEPTION 'Satisfied decision does not accept a reason' USING ERRCODE = '23514'; END IF;
    IF NEW.outcome = 'NOT_SATISFIED' AND (NEW.reason IS NULL OR char_length(btrim(NEW.reason)) = 0 OR char_length(NEW.reason) > 500) THEN RAISE EXCEPTION 'Not satisfied decision requires a reason' USING ERRCODE = '23514'; END IF;
  ELSE RAISE EXCEPTION 'Verification decision outcome is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_decision_guard BEFORE INSERT ON verification_decisions FOR EACH ROW EXECUTE FUNCTION guard_verification_decision();

ALTER TABLE verification_command_receipts DROP CONSTRAINT verification_receipt_shape;
ALTER TABLE verification_command_receipts ADD CONSTRAINT verification_receipt_shape CHECK (
  schema_version = 1
  AND scope_revision > 0
  AND payload_hash ~ '^[0-9a-f]{64}$'
  AND idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'
  AND (result->>'scopeRevision')::integer = scope_revision
  AND result ? 'scopeRevision'
  AND (
    (operation <> 'DECIDE' AND result ? 'requirements' AND jsonb_typeof(result->'requirements') = 'array')
    OR (operation = 'DECIDE' AND result ? 'decision' AND result ? 'verification' AND NOT (result ? 'requirements'))
  )
);

CREATE OR REPLACE FUNCTION guard_verification_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_scope integer;
BEGIN
  SELECT verification_scope_revision INTO current_scope FROM applications WHERE id = NEW.application_id FOR UPDATE;
  IF NEW.operation = 'DECIDE' THEN
    IF NEW.scope_revision IS DISTINCT FROM current_scope
       OR COALESCE((NEW.result->>'scopeRevision')::integer, -1) IS DISTINCT FROM NEW.scope_revision
       OR jsonb_typeof(NEW.result->'decision') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.result->'verification') IS DISTINCT FROM 'object'
       OR NEW.result ? 'requirements'
       OR (NEW.result->'verification'->>'state') NOT IN ('NOT_REQUESTED', 'AWAITING_EVIDENCE', 'PROCESSING', 'AWAITING_DECISION', 'NOT_SATISFIED', 'SATISFIED')
       OR NOT EXISTS (
         SELECT 1 FROM verification_decisions d
         JOIN application_document_requests r ON r.id = d.requirement_id
         WHERE d.id = (NEW.result->'decision'->>'id')::uuid
           AND d.application_id = NEW.application_id
           AND d.actor_user_id = NEW.actor_user_id
           AND d.requirement_id = (NEW.result->'decision'->>'requestId')::uuid
           AND d.outcome::text = NEW.result->'decision'->>'decision'
           AND d.scope_revision = NEW.scope_revision
           AND r.lifecycle_state = 'OPEN'
           AND r.application_id = NEW.application_id
           AND (
             (d.evidence_file_id IS NULL AND NEW.result->'decision'->'evidenceFileId' = 'null'::jsonb)
             OR d.evidence_file_id::text = NEW.result->'decision'->>'evidenceFileId'
           )
       )
    THEN RAISE EXCEPTION 'Invalid verification command result' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.scope_revision IS DISTINCT FROM current_scope OR jsonb_typeof(NEW.result->'requirements') IS DISTINCT FROM 'array' OR
     jsonb_array_length(NEW.result->'requirements') NOT BETWEEN 1 AND 20 OR
     (NEW.operation = 'CANCEL' AND jsonb_array_length(NEW.result->'requirements') <> 1) OR
     (NEW.operation = 'REPLACE' AND jsonb_array_length(NEW.result->'requirements') <> 2) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.result->'requirements') item WHERE NOT EXISTS (
         SELECT 1 FROM application_document_requests r WHERE r.id = (item->>'id')::uuid AND r.application_id = NEW.application_id AND
           r.revision = (item->>'revision')::integer AND r.round = (item->>'round')::integer AND r.lifecycle_state::text = (item->>'state') AND
           (r.created_scope_revision = NEW.scope_revision OR r.closed_scope_revision = NEW.scope_revision)
       )
     ) THEN RAISE EXCEPTION 'Invalid verification command result' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
