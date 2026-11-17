BEGIN;
CREATE FUNCTION guard_capacity_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u record; k "WorkspaceKind"; founder boolean:=false;
BEGIN
  IF TG_TABLE_NAME='workspace_memberships' THEN
    IF NEW.status='REMOVED' OR (TG_OP='UPDATE' AND OLD.status<>'REMOVED') THEN RETURN NEW; END IF;
    SELECT baseline_membership_id IS NULL INTO founder FROM workspace_ownership_revision_baselines
      WHERE workspace_id=NEW.workspace_id AND transaction_id=pg_current_xact_id()::text;
    IF TG_OP='INSERT' AND NEW.role='OWNER' AND founder AND
      (SELECT count(*) FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND status<>'REMOVED')=1 THEN RETURN NEW; END IF;
  END IF;
  PERFORM assert_capacity_transaction(NEW.workspace_id);
  SELECT * INTO STRICT u FROM workspace_capacity(NEW.workspace_id);
  SELECT kind INTO STRICT k FROM provider_workspaces WHERE id=NEW.workspace_id;
  IF k='PERSONAL' AND (u.listings_used>1 OR u.members_used>1 OR u.reservations_used>0) THEN
    RAISE EXCEPTION 'PERSONAL structural capacity' USING ERRCODE='23514',CONSTRAINT='personal_capacity';
  END IF;
  IF NOT EXISTS(SELECT FROM workspace_plan_assignments WHERE workspace_id=NEW.workspace_id AND plan_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PLAN_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='PLAN_UNAVAILABLE';
  END IF;
  IF u.listings_used>u.max_listings THEN RAISE EXCEPTION 'LISTING_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='LISTING_LIMIT_REACHED'; END IF;
  IF u.members_used+u.reservations_used>u.max_seats THEN RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE='23514',CONSTRAINT='SEAT_LIMIT_REACHED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_capacity_acquisition AFTER INSERT ON listings FOR EACH ROW EXECUTE FUNCTION guard_capacity_acquisition();
CREATE TRIGGER membership_capacity_acquisition AFTER INSERT OR UPDATE OF status ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION guard_capacity_acquisition();
CREATE TRIGGER reservation_capacity_acquisition AFTER INSERT ON workspace_seat_reservations FOR EACH ROW EXECUTE FUNCTION guard_capacity_acquisition();

CREATE FUNCTION guard_seat_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation evidence is durable' USING ERRCODE='23514'; END IF;
  PERFORM assert_capacity_transaction(NEW.workspace_id);
  IF TG_OP='INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR
      NOT EXISTS(SELECT FROM provider_workspaces WHERE id=NEW.workspace_id AND kind='ORGANIZATION' AND lifecycle_status='ACTIVE') THEN
      RAISE EXCEPTION 'Reservation is ineligible' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=clock_timestamp();
  ELSE
    IF (to_jsonb(NEW)-'released_at') IS DISTINCT FROM (to_jsonb(OLD)-'released_at') OR
      (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'Only terminal reservation release is supported' USING ERRCODE='23514';
    END IF;
    IF OLD.released_at IS NULL THEN NEW.released_at:=clock_timestamp(); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seat_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_seat_reservations FOR EACH ROW EXECUTE FUNCTION guard_seat_reservation();

DO $$ DECLARE s text:=current_schema(); f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_capacity_acquisition()','guard_seat_reservation()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
  END LOOP;
END $$;
COMMIT;
