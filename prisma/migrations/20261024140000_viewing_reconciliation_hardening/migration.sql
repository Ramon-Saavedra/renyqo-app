BEGIN;
CREATE OR REPLACE FUNCTION reconcile_legacy_viewing_workflow(app_id UUID) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE listing UUID; w viewing_workflows%ROWTYPE; source_row viewing_proposals%ROWTYPE;
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
  FOR source_row IN SELECT * FROM legacy_viewing_proposal_rows(app_id) ORDER BY round LOOP
    INSERT INTO viewing_proposals SELECT (source_row).* ON CONFLICT(id) DO UPDATE SET
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

