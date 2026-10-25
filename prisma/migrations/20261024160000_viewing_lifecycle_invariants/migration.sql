BEGIN;
CREATE OR REPLACE FUNCTION "assert_viewing_workflow"(target UUID) RETURNS void LANGUAGE plpgsql AS $$
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
      (p.timing <> 'legacy' AND v.status NOT IN ('accepted', 'cancelled', 'completed', 'no_show', 'superseded', 'outcome_pending')) OR
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


ALTER TABLE application_viewings ADD CONSTRAINT outcome_pending_was_accepted CHECK (status <> 'outcome_pending' OR accepted_at IS NOT NULL);
COMMIT;
