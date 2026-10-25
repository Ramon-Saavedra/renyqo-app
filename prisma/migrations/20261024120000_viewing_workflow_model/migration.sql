BEGIN;

-- CreateEnum
CREATE TYPE "ViewingParticipantSide" AS ENUM ('provider', 'applicant');

-- CreateEnum
CREATE TYPE "ViewingWorkflowMode" AS ENUM ('legacy', 'current');

-- CreateEnum
CREATE TYPE "ViewingWorkflowState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ViewingClosureReason" AS ENUM ('provider_closed', 'application_withdrawn', 'application_rejected', 'application_accepted', 'listing_rented', 'listing_archived', 'eligibility_rejected', 'post_viewing_response_expired');

-- CreateEnum
CREATE TYPE "ViewingProposalTiming" AS ENUM ('normal', 'short_notice', 'legacy');

-- CreateEnum
CREATE TYPE "ViewingProposalResolution" AS ENUM ('pending', 'accepted', 'declined', 'superseded', 'withdrawn', 'expired', 'closed');

-- CreateEnum
CREATE TYPE "ViewingCancellationReason" AS ENUM ('applicant_cancelled', 'provider_illness', 'provider_operational', 'property_unavailable', 'other', 'application_ended');

-- CreateEnum
CREATE TYPE "ViewingAbsenceSide" AS ENUM ('applicant', 'provider', 'both');

-- CreateEnum
CREATE TYPE "ViewingInterestState" AS ENUM ('not_requested', 'pending', 'still_interested', 'not_interested', 'expired', 'closed', 'legacy_unanswered');

-- CreateEnum
CREATE TYPE "ViewingProviderConsideration" AS ENUM ('undecided', 'continue_considering', 'do_not_continue');

-- AlterEnum
ALTER TYPE "ApplicationRejectionReason" ADD VALUE 'post_viewing_response_expired';

-- AlterTable
ALTER TABLE "application_viewing_outcomes" ADD COLUMN     "absence_side" "ViewingAbsenceSide";

-- CreateTable
CREATE TABLE "viewing_workflows" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "mode" "ViewingWorkflowMode" NOT NULL DEFAULT 'current',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "initiator_side" "ViewingParticipantSide" NOT NULL DEFAULT 'provider',
    "state" "ViewingWorkflowState" NOT NULL DEFAULT 'open',
    "closure_reason" "ViewingClosureReason",
    "closed_at" TIMESTAMPTZ(3),
    "pending_proposal_id" UUID,
    "confirmed_appointment_id" UUID,
    "provider_consideration" "ViewingProviderConsideration" NOT NULL DEFAULT 'undecided',
    "consideration_decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "viewing_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_proposals" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "proposer_side" "ViewingParticipantSide" NOT NULL,
    "responder_side" "ViewingParticipantSide" NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL,
    "message" VARCHAR(500),
    "predecessor_proposal_id" UUID,
    "base_appointment_id" UUID,
    "timing" "ViewingProposalTiming" NOT NULL,
    "response_deadline_at" TIMESTAMPTZ(3),
    "resolution" "ViewingProposalResolution" NOT NULL DEFAULT 'pending',
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" "ApplicationActivityActorType",
    "request_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "viewing_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_appointments" (
    "viewing_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "cancelled_by" "ApplicationActivityActorType",
    "cancellation_reason" "ViewingCancellationReason",
    "cancellation_note" VARCHAR(500),
    "late_cancellation" BOOLEAN,
    "interest_state" "ViewingInterestState" NOT NULL DEFAULT 'not_requested',
    "interest_requested_at" TIMESTAMPTZ(3),
    "interest_deadline_at" TIMESTAMPTZ(3),
    "interest_closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "viewing_appointments_pkey" PRIMARY KEY ("viewing_id")
);

-- CreateTable
CREATE TABLE "application_consideration_positions" (
    "application_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "position" BIGSERIAL NOT NULL,

    CONSTRAINT "application_consideration_positions_pkey" PRIMARY KEY ("application_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "viewing_workflows_application_id_key" ON "viewing_workflows"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_workflows_pending_proposal_id_key" ON "viewing_workflows"("pending_proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_workflows_confirmed_appointment_id_key" ON "viewing_workflows"("confirmed_appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_workflows_pending_proposal_id_id_key" ON "viewing_workflows"("pending_proposal_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_workflows_confirmed_appointment_id_id_key" ON "viewing_workflows"("confirmed_appointment_id", "id");

-- CreateIndex
CREATE INDEX "viewing_proposals_resolution_response_deadline_at_idx" ON "viewing_proposals"("resolution", "response_deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_proposals_workflow_id_round_key" ON "viewing_proposals"("workflow_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_proposals_workflow_id_request_key_key" ON "viewing_proposals"("workflow_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_proposals_id_workflow_id_key" ON "viewing_proposals"("id", "workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_appointments_proposal_id_key" ON "viewing_appointments"("proposal_id");

-- CreateIndex
CREATE INDEX "viewing_appointments_interest_state_interest_deadline_at_idx" ON "viewing_appointments"("interest_state", "interest_deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_appointments_viewing_id_workflow_id_key" ON "viewing_appointments"("viewing_id", "workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_appointments_proposal_id_workflow_id_key" ON "viewing_appointments"("proposal_id", "workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_consideration_positions_listing_id_position_key" ON "application_consideration_positions"("listing_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "application_consideration_positions_application_id_listing__key" ON "application_consideration_positions"("application_id", "listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_id_listing_id_key" ON "applications"("id", "listing_id");

-- AddForeignKey
ALTER TABLE "viewing_workflows" ADD CONSTRAINT "viewing_workflows_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_workflows" ADD CONSTRAINT "pending_proposal_same_workflow" FOREIGN KEY ("pending_proposal_id", "id") REFERENCES "viewing_proposals"("id", "workflow_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_workflows" ADD CONSTRAINT "confirmed_appointment_same_workflow" FOREIGN KEY ("confirmed_appointment_id", "id") REFERENCES "viewing_appointments"("viewing_id", "workflow_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_proposals" ADD CONSTRAINT "viewing_proposals_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "viewing_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_proposals" ADD CONSTRAINT "predecessor_same_workflow" FOREIGN KEY ("predecessor_proposal_id", "workflow_id") REFERENCES "viewing_proposals"("id", "workflow_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_proposals" ADD CONSTRAINT "base_appointment_same_workflow" FOREIGN KEY ("base_appointment_id", "workflow_id") REFERENCES "viewing_appointments"("viewing_id", "workflow_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_viewing_id_fkey" FOREIGN KEY ("viewing_id") REFERENCES "application_viewings"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "viewing_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "source_proposal_same_workflow" FOREIGN KEY ("proposal_id", "workflow_id") REFERENCES "viewing_proposals"("id", "workflow_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "application_consideration_positions" ADD CONSTRAINT "consideration_same_listing" FOREIGN KEY ("application_id", "listing_id") REFERENCES "applications"("id", "listing_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "application_consideration_positions" ADD CONSTRAINT "application_consideration_positions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;


-- Partial indexes, checks, backfill and deferred invariants supplement the Prisma model.
CREATE UNIQUE INDEX "viewing_one_pending_proposal" ON "viewing_proposals" ("workflow_id") WHERE "resolution" = 'pending';
ALTER TABLE "viewing_workflows" ADD CONSTRAINT "workflow_revision_nonnegative" CHECK ("revision" >= 0),
  ADD CONSTRAINT "workflow_provider_initiates" CHECK ("initiator_side" = 'provider'),
  ADD CONSTRAINT "workflow_closure" CHECK (
    ("state" = 'closed' AND "closed_at" IS NOT NULL AND "closure_reason" IS NOT NULL AND "pending_proposal_id" IS NULL AND "confirmed_appointment_id" IS NULL)
    OR ("state" = 'open' AND "closed_at" IS NULL AND "closure_reason" IS NULL)
  ),
  ADD CONSTRAINT "consideration_decision_time" CHECK ("provider_consideration" = 'undecided' OR "consideration_decided_at" IS NOT NULL);
ALTER TABLE "viewing_proposals" ADD CONSTRAINT "proposal_round" CHECK ("round" > 0),
  ADD CONSTRAINT "proposal_opposite_sides" CHECK ("proposer_side" <> "responder_side"),
  ADD CONSTRAINT "proposal_duration" CHECK ("ends_at" - "starts_at" BETWEEN INTERVAL '5 minutes' AND INTERVAL '240 minutes'),
  ADD CONSTRAINT "proposal_deadline" CHECK (
    ("timing" = 'legacy' AND "response_deadline_at" IS NULL) OR
    ("timing" <> 'legacy' AND "response_deadline_at" IS NOT NULL AND "response_deadline_at" > "created_at" AND "response_deadline_at" <= "starts_at" AND "response_deadline_at" <= "created_at" + INTERVAL '12 hours')
  ),
  ADD CONSTRAINT "proposal_normal_lead" CHECK ("timing" <> 'normal' OR "proposer_side" <> 'provider' OR "starts_at" >= "created_at" + INTERVAL '18 hours'),
  ADD CONSTRAINT "proposal_resolution_time" CHECK (
    ("resolution" = 'pending' AND "resolved_at" IS NULL AND "resolved_by" IS NULL) OR
    ("resolution" <> 'pending' AND "resolved_at" IS NOT NULL AND ("timing" = 'legacy' OR ("resolved_by" IS NOT NULL AND "resolved_at" >= "created_at")))
  ),
  ADD CONSTRAINT "proposal_message" CHECK ("timing" = 'legacy' OR "message" IS NULL OR length(btrim("message")) BETWEEN 1 AND 500);
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "interest_request_window" CHECK (
    ("interest_requested_at" IS NULL AND "interest_deadline_at" IS NULL) OR
    ("interest_requested_at" IS NOT NULL AND "interest_deadline_at" IS NOT NULL AND "interest_deadline_at" = "interest_requested_at" + INTERVAL '48 hours')
  ),
  ADD CONSTRAINT "interest_pending_deadline" CHECK ("interest_state" <> 'pending' OR ("interest_requested_at" IS NOT NULL AND "interest_deadline_at" IS NOT NULL AND "interest_closed_at" IS NULL)),
  ADD CONSTRAINT "interest_closure" CHECK (("interest_state" IN ('expired', 'closed')) = ("interest_closed_at" IS NOT NULL)),
  ADD CONSTRAINT "interest_expiry_time" CHECK ("interest_state" <> 'expired' OR ("interest_deadline_at" IS NOT NULL AND "interest_closed_at" >= "interest_deadline_at"));
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "interest_unrequested_shape" CHECK ("interest_state" NOT IN ('not_requested', 'legacy_unanswered') OR ("interest_requested_at" IS NULL AND "interest_deadline_at" IS NULL AND "interest_closed_at" IS NULL));
ALTER TABLE "viewing_proposals" ADD CONSTRAINT "proposal_resolution_actor" CHECK ("timing" = 'legacy' OR
  ("resolution" NOT IN ('accepted', 'declined') OR "resolved_by"::text = "responder_side"::text) AND
  ("resolution" <> 'withdrawn' OR "resolved_by"::text = "proposer_side"::text) AND
  ("resolution" <> 'expired' OR ("resolved_by" = 'system' AND "resolved_at" >= "response_deadline_at")) AND
  ("resolution" <> 'accepted' OR "resolved_at" < "response_deadline_at")
);
ALTER TABLE "application_viewing_outcomes" ADD CONSTRAINT "absence_only_no_show" CHECK ("outcome" = 'no_show' OR "absence_side" IS NULL);
ALTER TABLE "application_consideration_positions" ADD CONSTRAINT "consideration_positive" CHECK ("position" > 0);

-- This is a snapshot for explicit cutover, never a second live authoritative model.
-- Reuse application IDs for imported workflows, old viewing IDs for proposals and appointments.
INSERT INTO "viewing_workflows" ("id", "application_id", "mode", "created_at", "updated_at")
SELECT "application_id", "application_id", 'legacy', min("created_at"), max("updated_at") FROM "application_viewings" GROUP BY "application_id";
INSERT INTO "viewing_proposals" ("id", "workflow_id", "round", "proposer_side", "responder_side", "starts_at", "ends_at", "time_zone", "message", "timing", "resolution", "resolved_at", "request_key", "request_hash", "created_at")
SELECT "id", "application_id", "round", 'provider', 'applicant', "starts_at", "ends_at", "time_zone", "provider_note", 'legacy',
  CASE WHEN "accepted_at" IS NOT NULL THEN 'accepted'
       WHEN "status" = 'proposed' THEN 'pending'
       WHEN "status" IN ('declined', 'change_requested') THEN 'declined'
       WHEN "status" = 'superseded' THEN 'superseded'
       ELSE 'closed' END::"ViewingProposalResolution",
  COALESCE("accepted_at", "declined_at", "change_requested_at", "superseded_at", "cancelled_at"), "request_key", "request_hash", "created_at"
FROM "application_viewings";
INSERT INTO "viewing_appointments" ("viewing_id", "workflow_id", "proposal_id", "interest_state")
SELECT v."id", v."application_id", v."id",
  CASE WHEN i."interest" = 'still_interested' THEN 'still_interested'
       WHEN i."interest" = 'not_interested' THEN 'not_interested'
       WHEN v."status" = 'completed' THEN 'legacy_unanswered'
       ELSE 'not_requested' END::"ViewingInterestState"
FROM "application_viewings" v LEFT JOIN "application_viewing_interests" i ON i."viewing_id" = v."id"
WHERE v."accepted_at" IS NOT NULL;
-- Only recover predecessor links explicitly recorded in activity, never infer an alternative time.
UPDATE "viewing_proposals" p SET "predecessor_proposal_id" = links.previous_id,
  "base_appointment_id" = CASE WHEN links.accepted_at IS NOT NULL THEN links.previous_id END
FROM (
  SELECT DISTINCT ON (v.id) v.id, previous.id AS previous_id, previous.accepted_at
  FROM "application_viewings" v JOIN "application_activities" a ON a."application_id" = v."application_id" AND a."payload"->>'viewingId' = v."id"::text
  JOIN "application_viewings" previous ON previous."id"::text = a."payload"->>'previousViewingId' AND previous."application_id" = v."application_id" AND previous."round" < v."round"
  ORDER BY v.id, a.occurred_at, a.id
) links WHERE p.id = links.id;
UPDATE "viewing_workflows" w SET "pending_proposal_id" = (
  SELECT p.id FROM "viewing_proposals" p WHERE p.workflow_id = w.id AND p.resolution = 'pending'
), "confirmed_appointment_id" = (
  SELECT a.viewing_id FROM "viewing_appointments" a JOIN "application_viewings" v ON v.id = a.viewing_id WHERE a.workflow_id = w.id AND v.status = 'accepted'
);
-- Copy existing ACTIVE display order, without using profile/income or altering WAITING.
INSERT INTO "application_consideration_positions" ("application_id", "listing_id", "position")
SELECT id, listing_id, row_number() OVER (ORDER BY listing_id, active_at ASC NULLS LAST, id) FROM "applications" WHERE status = 'active';
SELECT setval(pg_get_serial_sequence('application_consideration_positions', 'position'), COALESCE(max(position), 1), count(*) > 0) FROM "application_consideration_positions";

CREATE FUNCTION "guard_viewing_proposal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Proposal history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW.id, NEW.workflow_id, NEW.round, NEW.proposer_side, NEW.responder_side, NEW.starts_at, NEW.ends_at, NEW.time_zone, NEW.message, NEW.predecessor_proposal_id, NEW.base_appointment_id, NEW.timing, NEW.response_deadline_at, NEW.request_key, NEW.request_hash, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.workflow_id, OLD.round, OLD.proposer_side, OLD.responder_side, OLD.starts_at, OLD.ends_at, OLD.time_zone, OLD.message, OLD.predecessor_proposal_id, OLD.base_appointment_id, OLD.timing, OLD.response_deadline_at, OLD.request_key, OLD.request_hash, OLD.created_at)
    OR (OLD.resolution <> 'pending' AND ROW(NEW.resolution, NEW.resolved_at, NEW.resolved_by) IS DISTINCT FROM ROW(OLD.resolution, OLD.resolved_at, OLD.resolved_by))
  ) THEN RAISE EXCEPTION 'Proposal schedule and resolved decisions are immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW.timing = 'legacy' THEN RAISE EXCEPTION 'Legacy proposals are migration-only' USING ERRCODE = '23514'; END IF;
  IF NEW.timing <> 'legacy' AND (
    NEW.time_zone !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$' OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone)
  ) THEN RAISE EXCEPTION 'IANA timezone required' USING ERRCODE = '23514'; END IF;
  UPDATE viewing_workflows SET revision = revision WHERE id = NEW.workflow_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER "proposal_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "viewing_proposals" FOR EACH ROW EXECUTE FUNCTION "guard_viewing_proposal"();

CREATE FUNCTION "guard_viewing_workflow"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.mode = 'legacy' THEN RAISE EXCEPTION 'Legacy workflows are migration-only' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.initiator_side <> OLD.initiator_side OR NEW.created_at <> OLD.created_at OR (OLD.mode = 'current' AND NEW.mode <> 'current') THEN
    RAISE EXCEPTION 'Workflow identity and cutover cannot be reversed' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Workflow updates require the next revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "workflow_revision" BEFORE INSERT OR UPDATE ON "viewing_workflows" FOR EACH ROW EXECUTE FUNCTION "guard_viewing_workflow"();

CREATE FUNCTION "guard_viewing_appointment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Appointment history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.viewing_id, NEW.workflow_id, NEW.proposal_id) IS DISTINCT FROM ROW(OLD.viewing_id, OLD.workflow_id, OLD.proposal_id) THEN
    RAISE EXCEPTION 'Appointment source is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.interest_requested_at IS NOT NULL AND ROW(NEW.interest_requested_at, NEW.interest_deadline_at) IS DISTINCT FROM ROW(OLD.interest_requested_at, OLD.interest_deadline_at) THEN
    RAISE EXCEPTION 'An opened interest deadline cannot be extended or reset' USING ERRCODE = '23514';
  END IF;
  UPDATE viewing_workflows SET revision = revision WHERE id = NEW.workflow_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER "appointment_source_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "viewing_appointments" FOR EACH ROW EXECUTE FUNCTION "guard_viewing_appointment"();

CREATE FUNCTION "assert_viewing_workflow"(target UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w viewing_workflows%ROWTYPE;
BEGIN
  SELECT * INTO w FROM viewing_workflows WHERE id = target;
  IF NOT FOUND OR w.mode = 'legacy' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM viewing_proposals WHERE workflow_id = target) OR (
    SELECT proposer_side <> 'provider' OR predecessor_proposal_id IS NOT NULL OR base_appointment_id IS NOT NULL FROM viewing_proposals WHERE workflow_id = target ORDER BY round LIMIT 1
  ) THEN RAISE EXCEPTION 'Provider must initiate the workflow' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM viewing_proposals p LEFT JOIN viewing_proposals previous ON previous.id = p.predecessor_proposal_id LEFT JOIN viewing_appointments base ON base.viewing_id = p.base_appointment_id LEFT JOIN viewing_proposals base_source ON base_source.id = base.proposal_id
    WHERE p.workflow_id = target AND (
      (p.proposer_side = 'applicant' AND p.base_appointment_id IS NULL AND (previous.id IS NULL OR previous.proposer_side <> 'provider')) OR
      (previous.id IS NOT NULL AND previous.round >= p.round) OR (base_source.id IS NOT NULL AND base_source.round >= p.round)
    )
  ) THEN RAISE EXCEPTION 'Alternative requires an earlier invitation or appointment' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM viewing_proposals WHERE workflow_id = target AND resolution = 'pending' AND id IS DISTINCT FROM w.pending_proposal_id) OR
     (w.pending_proposal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM viewing_proposals WHERE id = w.pending_proposal_id AND resolution = 'pending')) THEN
    RAISE EXCEPTION 'Pending proposal pointer must match the pending round' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM viewing_appointments a JOIN application_viewings v ON v.id = a.viewing_id JOIN viewing_proposals p ON p.id = a.proposal_id
    WHERE a.workflow_id = target AND (
      v.application_id <> w.application_id OR p.resolution <> 'accepted' OR v.accepted_at IS NULL OR
      ROW(v.starts_at, v.ends_at, v.time_zone) IS DISTINCT FROM ROW(p.starts_at, p.ends_at, p.time_zone) OR
      (v.status = 'accepted' AND a.viewing_id IS DISTINCT FROM w.confirmed_appointment_id) OR
      (p.timing <> 'legacy' AND v.status NOT IN ('accepted', 'cancelled', 'completed', 'no_show', 'superseded')) OR
      (p.timing <> 'legacy' AND v.status = 'cancelled' AND (a.cancelled_by IS NULL OR a.cancellation_reason IS NULL)) OR
      (p.timing <> 'legacy' AND v.status <> 'cancelled' AND (a.cancelled_by IS NOT NULL OR a.cancellation_reason IS NOT NULL OR a.cancellation_note IS NOT NULL OR a.late_cancellation IS NOT NULL)) OR
      (a.interest_state = 'legacy_unanswered' AND (p.timing <> 'legacy' OR v.status <> 'completed')) OR
      (a.interest_state NOT IN ('not_requested', 'closed') AND v.status <> 'completed') OR
      (p.timing <> 'legacy' AND v.status = 'completed' AND a.interest_state = 'not_requested') OR
      (p.timing <> 'legacy' AND a.interest_state IN ('still_interested', 'not_interested') AND a.interest_deadline_at IS NULL) OR
      ((a.interest_state IN ('still_interested', 'not_interested')) IS DISTINCT FROM EXISTS (SELECT 1 FROM application_viewing_interests i WHERE i.viewing_id = v.id)) OR
      EXISTS (SELECT 1 FROM application_viewing_interests i WHERE i.viewing_id = v.id AND i.interest::text <> a.interest_state::text) OR
      (p.timing <> 'legacy' AND EXISTS (SELECT 1 FROM application_viewing_outcomes o WHERE o.viewing_id = v.id AND o.outcome = 'no_show' AND o.absence_side IS NULL))
    )
  ) THEN RAISE EXCEPTION 'Appointment source, attribution or interest state is inconsistent' USING ERRCODE = '23514'; END IF;
  IF w.confirmed_appointment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM viewing_appointments a JOIN application_viewings v ON v.id = a.viewing_id WHERE a.viewing_id = w.confirmed_appointment_id AND v.status = 'accepted'
  ) THEN RAISE EXCEPTION 'Confirmed pointer must reference an active commitment' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM viewing_proposals p WHERE p.workflow_id = target AND p.resolution = 'accepted' AND NOT EXISTS (SELECT 1 FROM viewing_appointments a WHERE a.proposal_id = p.id)) THEN
    RAISE EXCEPTION 'Accepted proposal requires its appointment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM application_viewings v WHERE v.application_id = w.application_id AND NOT EXISTS (SELECT 1 FROM viewing_appointments a WHERE a.viewing_id = v.id) AND NOT EXISTS (SELECT 1 FROM viewing_proposals p WHERE p.id = v.id AND p.timing = 'legacy')
  ) THEN RAISE EXCEPTION 'Current workflow writes require an appointment record' USING ERRCODE = '23514'; END IF;
  IF w.provider_consideration = 'do_not_continue' AND NOT EXISTS (SELECT 1 FROM applications WHERE id = w.application_id AND status = 'rejected' AND public_reason = 'not_selected') THEN
    RAISE EXCEPTION 'Provider non-selection requires actual application rejection' USING ERRCODE = '23514';
  END IF;
END; $$;

-- All final-state checks are deferred so pointer swaps, acceptance, outcomes and
-- interest responses can be written in either order in one transaction.
CREATE FUNCTION "check_viewing_workflow"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
  IF TG_TABLE_NAME = 'viewing_workflows' THEN target := NEW.id;
  ELSIF TG_TABLE_NAME IN ('viewing_proposals', 'viewing_appointments') THEN target := NEW.workflow_id;
  ELSIF TG_TABLE_NAME = 'applications' THEN SELECT id INTO target FROM viewing_workflows WHERE application_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'application_viewings' THEN SELECT id INTO target FROM viewing_workflows WHERE application_id = NEW.application_id;
  ELSE SELECT w.id INTO target FROM viewing_workflows w JOIN application_viewings v ON v.application_id = w.application_id WHERE v.id = NEW.viewing_id;
  END IF;
  PERFORM assert_viewing_workflow(target);
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "workflow_consistent" AFTER INSERT OR UPDATE ON "viewing_workflows" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "proposal_workflow_consistent" AFTER INSERT OR UPDATE ON "viewing_proposals" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "appointment_workflow_consistent" AFTER INSERT OR UPDATE ON "viewing_appointments" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "viewing_workflow_consistent" AFTER INSERT OR UPDATE ON "application_viewings" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "outcome_workflow_consistent" AFTER INSERT ON "application_viewing_outcomes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "interest_workflow_consistent" AFTER INSERT ON "application_viewing_interests" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();
CREATE CONSTRAINT TRIGGER "application_workflow_consistent" AFTER UPDATE ON "applications" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_viewing_workflow"();

COMMIT;
