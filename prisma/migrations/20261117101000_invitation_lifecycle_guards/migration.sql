BEGIN;
CREATE FUNCTION guard_invitation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issuer workspace_memberships%ROWTYPE; u users%ROWTYPE; w provider_workspaces%ROWTYPE; r workspace_seat_reservations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Invitation history is durable' USING ERRCODE='23514'; END IF;
  PERFORM assert_capacity_transaction(NEW.workspace_id);
  SELECT * INTO STRICT w FROM provider_workspaces WHERE id=NEW.workspace_id;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.workspace_id,NEW.email,NEW.role,NEW.created_by_membership_id,NEW.reservation_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.email,OLD.role,OLD.created_by_membership_id,OLD.reservation_id,OLD.created_at,OLD.expires_at) THEN
      RAISE EXCEPTION 'Invitation intent is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.revision<>OLD.revision OR NEW.generation<>OLD.generation THEN RAISE EXCEPTION 'Invitation revisions are derived' USING ERRCODE='23514'; END IF;
    IF (to_jsonb(NEW)-'delivery_status')=(to_jsonb(OLD)-'delivery_status') THEN RETURN NEW; END IF;
    IF OLD.status<>'PENDING' THEN RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
    NEW.revision:=OLD.revision+1;
    IF NEW.status='PENDING' THEN
      IF NEW.token_hash=OLD.token_hash OR clock_timestamp()>=OLD.expires_at THEN RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
      NEW.generation:=OLD.generation+1; NEW.issued_at:=clock_timestamp(); NEW.delivery_status:='UNKNOWN';
    ELSE
      IF ROW(NEW.token_hash,NEW.issued_at,NEW.issuer_membership_revision,NEW.issuer_auth_version,NEW.ownership_revision) IS DISTINCT FROM
        ROW(OLD.token_hash,OLD.issued_at,OLD.issuer_membership_revision,OLD.issuer_auth_version,OLD.ownership_revision) THEN RAISE EXCEPTION 'Terminal terms are immutable' USING ERRCODE='23514'; END IF;
      IF NEW.status='REVOKED' THEN NEW.revoked_at:=clock_timestamp();
      ELSIF NEW.status='EXPIRED' THEN
        IF clock_timestamp()<OLD.expires_at THEN RAISE EXCEPTION 'Invitation has not expired' USING ERRCODE='23514'; END IF;
        NEW.expired_at:=OLD.expires_at;
      ELSIF NEW.status='ACCEPTED' THEN
        IF clock_timestamp()>=OLD.expires_at THEN RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
        NEW.accepted_at:=clock_timestamp();
      END IF;
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.status<>'PENDING' OR NEW.revision<>1 OR NEW.generation<>1 THEN RAISE EXCEPTION 'Invitation establishes pending' USING ERRCODE='23514'; END IF;
    NEW.created_at:=clock_timestamp();NEW.issued_at:=NEW.created_at;
  END IF;
  SELECT * INTO STRICT issuer FROM workspace_memberships WHERE id=NEW.created_by_membership_id AND workspace_id=NEW.workspace_id;
  SELECT * INTO STRICT u FROM users WHERE id=issuer.user_id;
  SELECT * INTO STRICT r FROM workspace_seat_reservations WHERE id=NEW.reservation_id AND workspace_id=NEW.workspace_id;
  IF w.kind<>'ORGANIZATION' OR w.lifecycle_status<>'ACTIVE' OR issuer.role<>'OWNER' OR issuer.status<>'ACTIVE' OR u.status<>'active'
    OR issuer.revision<>NEW.issuer_membership_revision OR u.auth_version<>NEW.issuer_auth_version OR w.ownership_revision<>NEW.ownership_revision
    OR r.released_at IS NOT NULL OR r.expires_at<>NEW.expires_at OR NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitation_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION guard_invitation_lifecycle();

-- Invoker gate distinguishes ordinary runtime DML from the narrow admission/fact helpers.
CREATE FUNCTION invitation_completion_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status='ACCEPTED' AND OLD.status<>'ACCEPTED') OR (NEW.token_hash=OLD.token_hash AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status) THEN
    IF current_user<>'renyqo_workspace_invariants' THEN RAISE EXCEPTION 'Use the bounded invitation completion helper' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitation_completion_boundary BEFORE UPDATE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION invitation_completion_gate();

CREATE FUNCTION verify_invitation_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i workspace_invitations%ROWTYPE; r workspace_seat_reservations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT i FROM workspace_invitations WHERE id=NEW.id;
  SELECT * INTO STRICT r FROM workspace_seat_reservations WHERE id=i.reservation_id AND workspace_id=i.workspace_id;
  IF i.status<>'PENDING' AND r.released_at IS NULL THEN RAISE EXCEPTION 'Terminal invitation must release reservation' USING ERRCODE='23514'; END IF;
  IF i.status='ACCEPTED' AND (TG_OP='INSERT' OR OLD.status<>'ACCEPTED') AND NOT EXISTS(SELECT FROM workspace_memberships WHERE id=i.accepted_membership_id AND workspace_id=i.workspace_id AND user_id=i.accepted_user_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'Accepted invitation requires its active canonical membership' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invitation_consistency AFTER INSERT OR UPDATE ON workspace_invitations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_invitation_consistency();

CREATE FUNCTION invitation_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Invitation command evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER invitation_command_immutable BEFORE UPDATE OR DELETE ON workspace_invitation_commands FOR EACH ROW EXECUTE FUNCTION invitation_evidence_immutable();
DO $$ DECLARE s text:=current_schema(); f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_invitation_lifecycle()','verify_invitation_consistency()','invitation_evidence_immutable()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.invitation_completion_gate() SET search_path=pg_catalog,%I,pg_temp',s,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.invitation_completion_gate() FROM PUBLIC',s);
END $$;
COMMIT;
