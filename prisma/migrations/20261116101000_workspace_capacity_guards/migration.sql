BEGIN;
CREATE FUNCTION assert_capacity_transaction(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(target);
  IF current_setting('transaction_isolation')<>'serializable' OR NOT EXISTS(
    SELECT FROM workspace_ownership_revision_baselines WHERE workspace_id=target
      AND transaction_id=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Capacity acquisition requires Serializable workspace root protocol' USING ERRCODE='23514',CONSTRAINT='capacity_transaction';
  END IF;
END $$;

CREATE FUNCTION workspace_capacity(target uuid)
RETURNS TABLE(listings_used bigint,members_used bigint,reservations_used bigint,max_listings integer,max_seats integer)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(target);
  RETURN QUERY SELECT
    (SELECT count(*) FROM listings WHERE workspace_id=target AND status<>'retired'),
    (SELECT count(*) FROM workspace_memberships WHERE workspace_id=target AND status<>'REMOVED'),
    (SELECT count(*) FROM workspace_seat_reservations WHERE workspace_id=target AND released_at IS NULL AND expires_at>clock_timestamp()),
    CASE WHEN w.kind='PERSONAL' THEN least(coalesce(p.max_listings,0),1) ELSE coalesce(p.max_listings,0) END,
    CASE WHEN w.kind='PERSONAL' THEN least(coalesce(p.max_seats,0),1) ELSE coalesce(p.max_seats,0) END
  FROM provider_workspaces w LEFT JOIN workspace_plan_assignments a ON a.workspace_id=w.id
    LEFT JOIN plan_versions p ON p.id=a.plan_version_id WHERE w.id=target;
END $$;

CREATE FUNCTION guard_workspace_plan_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k "WorkspaceKind"; p plan_versions%ROWTYPE; u record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Plan assignment history is durable' USING ERRCODE='23514'; END IF;
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  SELECT kind INTO STRICT k FROM provider_workspaces WHERE id=NEW.workspace_id;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.source<>'BASELINE' OR NEW.actor_membership_id IS NOT NULL OR
      EXISTS(SELECT FROM workspace_memberships WHERE workspace_id=NEW.workspace_id) OR
      NEW.plan_version_id IS DISTINCT FROM (CASE WHEN k='PERSONAL' THEN '45700000-0000-4000-8000-000000000001'::uuid END) THEN
      RAISE EXCEPTION 'Assignment initialization requires workspace establishment' USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM assert_capacity_transaction(NEW.workspace_id);
    IF NEW.workspace_id<>OLD.workspace_id OR NEW.revision<>OLD.revision OR NEW.source='BASELINE' THEN
      RAISE EXCEPTION 'Plan assignment revision is database-derived' USING ERRCODE='23514';
    END IF;
    NEW.revision:=OLD.revision+1;
    IF NEW.actor_membership_id IS NULL OR NOT EXISTS(SELECT FROM workspace_memberships WHERE id=NEW.actor_membership_id
      AND workspace_id=NEW.workspace_id AND role='OWNER' AND status='ACTIVE') THEN
      RAISE EXCEPTION 'Plan administration requires current OWNER' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.plan_version_id IS NOT NULL THEN
    SELECT * INTO STRICT p FROM plan_versions WHERE id=NEW.plan_version_id;
    IF p.workspace_kind<>k THEN RAISE EXCEPTION 'Plan kind mismatch' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND NEW.change_mode='VOLUNTARY' THEN
      SELECT * INTO u FROM workspace_capacity(NEW.workspace_id);
      IF u.listings_used>p.max_listings OR u.members_used+u.reservations_used>p.max_seats THEN
        RAISE EXCEPTION 'DOWNGRADE_BLOCKED' USING ERRCODE='23514',CONSTRAINT='DOWNGRADE_BLOCKED';
      END IF;
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.change_mode='VOLUNTARY' THEN
    -- An established workspace always has at least its designated OWNER seat.
    RAISE EXCEPTION 'DOWNGRADE_BLOCKED' USING ERRCODE='23514',CONSTRAINT='DOWNGRADE_BLOCKED';
  ELSIF k='PERSONAL' THEN
    RAISE EXCEPTION 'PERSONAL requires free plan' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER workspace_plan_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_plan_assignments
FOR EACH ROW EXECUTE FUNCTION guard_workspace_plan_assignment();

CREATE FUNCTION preserve_entitlement_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published plans and plan history are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER published_plan_immutable BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION preserve_entitlement_evidence();
CREATE TRIGGER plan_change_immutable BEFORE UPDATE OR DELETE ON workspace_plan_changes FOR EACH ROW EXECUTE FUNCTION preserve_entitlement_evidence();

DO $$ DECLARE s text:=current_schema(); f text; BEGIN
  FOREACH f IN ARRAY ARRAY['assert_capacity_transaction(uuid)','workspace_capacity(uuid)','guard_workspace_plan_assignment()','preserve_entitlement_evidence()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
  END LOOP;
END $$;
COMMIT;
