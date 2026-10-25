BEGIN;
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_replacement_proposed';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_proposal_withdrawn';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_proposal_expired';

CREATE TABLE viewing_command_receipts (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  request_key UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_side "ViewingParticipantSide" NOT NULL,
  command VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  outcome JSONB NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX viewing_command_receipts_application_id_request_key_key ON viewing_command_receipts(application_id,request_key);
CREATE FUNCTION guard_viewing_command_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Command receipts are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER viewing_command_receipt_immutable BEFORE UPDATE OR DELETE ON viewing_command_receipts FOR EACH ROW EXECUTE FUNCTION guard_viewing_command_receipt();

-- Canonical projection of actual legacy records. This is not a permission flag:
-- import guards compare the entire proposed row to this source under locks.
CREATE FUNCTION legacy_viewing_proposal_rows(app_id UUID) RETURNS SETOF viewing_proposals LANGUAGE sql STABLE AS $$
  SELECT v.id, v.application_id, v.round, 'provider'::"ViewingParticipantSide", 'applicant'::"ViewingParticipantSide",
    v.starts_at, v.ends_at, v.time_zone, v.provider_note, previous.id,
    CASE WHEN previous.accepted_at IS NOT NULL THEN previous.id END,
    'legacy'::"ViewingProposalTiming", NULL::timestamptz,
    CASE WHEN v.accepted_at IS NOT NULL THEN 'accepted'
         WHEN v.status='proposed' THEN 'pending'
         WHEN v.status IN ('declined','change_requested') THEN 'declined'
         WHEN v.status='superseded' THEN 'superseded' ELSE 'closed' END::"ViewingProposalResolution",
    COALESCE(v.accepted_at,v.declined_at,v.change_requested_at,v.superseded_at,v.cancelled_at),
    NULL::"ApplicationActivityActorType", v.request_key,v.request_hash,v.created_at
  FROM application_viewings v
  LEFT JOIN LATERAL (
    SELECT prior.id, prior.accepted_at FROM application_activities a
    JOIN application_viewings prior ON prior.id::text=a.payload->>'previousViewingId'
      AND prior.application_id=v.application_id AND prior.round<v.round
    WHERE a.application_id=v.application_id AND a.payload->>'viewingId'=v.id::text
    ORDER BY a.occurred_at,a.id LIMIT 1
  ) previous ON true WHERE v.application_id=app_id;
$$;

CREATE OR REPLACE FUNCTION guard_viewing_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legacy_mode BOOLEAN;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Proposal history cannot be deleted' USING ERRCODE='23514'; END IF;
  UPDATE viewing_workflows SET revision=revision WHERE id=NEW.workflow_id;
  SELECT mode='legacy' INTO legacy_mode FROM viewing_workflows WHERE id=NEW.workflow_id;
  IF legacy_mode THEN
    IF NOT EXISTS (SELECT 1 FROM legacy_viewing_proposal_rows(NEW.workflow_id) p WHERE p IS NOT DISTINCT FROM NEW) THEN
      RAISE EXCEPTION 'Legacy projection must match its actual ledger and activity' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.id,NEW.workflow_id,NEW.round,NEW.proposer_side,NEW.responder_side,NEW.starts_at,NEW.ends_at,NEW.time_zone,NEW.message,NEW.predecessor_proposal_id,NEW.base_appointment_id,NEW.timing,NEW.response_deadline_at,NEW.request_key,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.workflow_id,OLD.round,OLD.proposer_side,OLD.responder_side,OLD.starts_at,OLD.ends_at,OLD.time_zone,OLD.message,OLD.predecessor_proposal_id,OLD.base_appointment_id,OLD.timing,OLD.response_deadline_at,OLD.request_key,OLD.request_hash,OLD.created_at)
    OR (OLD.resolution<>'pending' AND ROW(NEW.resolution,NEW.resolved_at,NEW.resolved_by) IS DISTINCT FROM ROW(OLD.resolution,OLD.resolved_at,OLD.resolved_by))
  ) THEN RAISE EXCEPTION 'Proposal schedule and resolved decisions are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.timing='legacy' THEN RAISE EXCEPTION 'Legacy proposals require reconciliation' USING ERRCODE='23514'; END IF;
  IF NEW.timing<>'legacy' AND (NEW.time_zone !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.time_zone)) THEN
    RAISE EXCEPTION 'IANA timezone required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION guard_viewing_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.mode='legacy' AND (NEW.id<>NEW.application_id OR NOT EXISTS(SELECT 1 FROM application_viewings WHERE application_id=NEW.application_id)) THEN
      RAISE EXCEPTION 'Legacy workflow requires real legacy history' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.application_id<>OLD.application_id OR NEW.initiator_side<>OLD.initiator_side OR NEW.created_at<>OLD.created_at OR (OLD.mode='current' AND NEW.mode<>'current') THEN
    RAISE EXCEPTION 'Workflow identity and cutover cannot be reversed' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) AND NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Workflow updates require the next revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION reconcile_legacy_viewing_workflow(app_id UUID) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE listing UUID; w viewing_workflows%ROWTYPE; p viewing_proposals%ROWTYPE;
BEGIN
  SELECT listing_id INTO STRICT listing FROM applications WHERE id=app_id;
  PERFORM id FROM listings WHERE id=listing FOR UPDATE;
  PERFORM id FROM applications WHERE id=app_id FOR UPDATE;
  SELECT * INTO w FROM viewing_workflows WHERE application_id=app_id FOR UPDATE;
  IF FOUND AND w.mode='current' THEN RETURN w.id; END IF;
  IF w.id IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM application_viewings WHERE application_id=app_id) THEN RETURN NULL; END IF;
    INSERT INTO viewing_workflows(id,application_id,mode,created_at,updated_at)
      SELECT app_id,app_id,'legacy',min(created_at),max(updated_at) FROM application_viewings WHERE application_id=app_id RETURNING * INTO w;
  END IF;
  IF EXISTS(SELECT 1 FROM viewing_proposals p WHERE p.workflow_id=w.id AND (p.timing<>'legacy' OR NOT EXISTS(SELECT 1 FROM application_viewings v WHERE v.id=p.id AND v.application_id=app_id))) THEN
    RAISE EXCEPTION 'Legacy projection contains unverifiable history' USING ERRCODE='23514';
  END IF;
  FOR p IN SELECT * FROM legacy_viewing_proposal_rows(app_id) ORDER BY round LOOP
    INSERT INTO viewing_proposals SELECT (p).* ON CONFLICT(id) DO UPDATE SET
      round=EXCLUDED.round,proposer_side=EXCLUDED.proposer_side,responder_side=EXCLUDED.responder_side,
      starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,time_zone=EXCLUDED.time_zone,message=EXCLUDED.message,
      predecessor_proposal_id=EXCLUDED.predecessor_proposal_id,base_appointment_id=EXCLUDED.base_appointment_id,
      timing=EXCLUDED.timing,response_deadline_at=EXCLUDED.response_deadline_at,resolution=EXCLUDED.resolution,
      resolved_at=EXCLUDED.resolved_at,resolved_by=EXCLUDED.resolved_by,request_key=EXCLUDED.request_key,
      request_hash=EXCLUDED.request_hash,created_at=EXCLUDED.created_at;
  END LOOP;
  INSERT INTO viewing_appointments(viewing_id,workflow_id,proposal_id,interest_state)
    SELECT v.id,w.id,v.id,CASE WHEN i.interest='still_interested' THEN 'still_interested' WHEN i.interest='not_interested' THEN 'not_interested' WHEN v.status='completed' THEN 'legacy_unanswered' ELSE 'not_requested' END::"ViewingInterestState"
    FROM application_viewings v LEFT JOIN application_viewing_interests i ON i.viewing_id=v.id WHERE v.application_id=app_id AND v.accepted_at IS NOT NULL
    ON CONFLICT(viewing_id) DO UPDATE SET interest_state=EXCLUDED.interest_state;
  UPDATE viewing_workflows SET mode='current',revision=revision+1,
    pending_proposal_id=(SELECT id FROM viewing_proposals WHERE workflow_id=w.id AND resolution='pending'),
    confirmed_appointment_id=(SELECT a.viewing_id FROM viewing_appointments a JOIN application_viewings v ON v.id=a.viewing_id WHERE a.workflow_id=w.id AND v.status='accepted'),
    updated_at=clock_timestamp() WHERE id=w.id;
  PERFORM assert_viewing_workflow(w.id);
  RETURN w.id;
END; $$;
COMMIT;
