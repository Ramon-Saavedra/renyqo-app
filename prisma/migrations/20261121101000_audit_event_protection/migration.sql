BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.guard_audit_event_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      PERFORM %1$I.assert_workspace_tenant(NEW.workspace_id);
      IF NEW.actor_kind='USER' AND NOT EXISTS(SELECT FROM %1$I.users WHERE id=NEW.actor_user_id) THEN
        RAISE EXCEPTION 'Invalid audit actor' USING ERRCODE='23514';
      END IF;
      IF NEW.actor_kind='MEMBER' AND NOT EXISTS(
        SELECT FROM %1$I.workspace_memberships WHERE id=NEW.actor_membership_id
          AND workspace_id=NEW.workspace_id AND user_id=NEW.actor_user_id) THEN
        RAISE EXCEPTION 'Invalid audit actor' USING ERRCODE='23514';
      END IF;
      NEW.recorded_at:=clock_timestamp();
      RETURN NEW;
    END $fn$;
    CREATE FUNCTION %1$I.reject_audit_event_mutation() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE='23514';
    END $fn$;
  $ddl$,s);
  EXECUTE format('CREATE TRIGGER audit_event_insert_guard BEFORE INSERT ON %I.audit_events FOR EACH ROW EXECUTE FUNCTION %I.guard_audit_event_insert()',s,s);
  EXECUTE format('CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON %I.audit_events FOR EACH ROW EXECUTE FUNCTION %I.reject_audit_event_mutation()',s,s);
  EXECUTE format('ALTER FUNCTION %I.guard_audit_event_insert() OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.guard_audit_event_insert(),%I.reject_audit_event_mutation() FROM PUBLIC,renyqo_workspace_runtime',s,s);
  EXECUTE format('ALTER TABLE %I.audit_events OWNER TO renyqo_workspace_owner',s);
  EXECUTE format('ALTER TABLE %I.audit_events ENABLE ROW LEVEL SECURITY',s);
  EXECUTE format('ALTER TABLE %I.audit_events FORCE ROW LEVEL SECURITY',s);
  EXECUTE format('REVOKE ALL ON %I.audit_events FROM PUBLIC,renyqo_workspace_runtime,renyqo_workspace_invariants',s);
  -- TRUNCATE is denied by privilege, including for the invariant role. The
  -- trusted migrator retains explicit disposable-test/maintenance operations;
  -- an unconditional statement trigger would break the existing E2E reset.
  -- No runtime reader/writer is activated. Privileged future adapters use only
  -- the selected tenant, with no owner/BYPASSRLS role membership at runtime.
  EXECUTE format('GRANT SELECT,INSERT ON %I.audit_events TO renyqo_workspace_invariants',s);
  EXECUTE format('CREATE POLICY audit_invariant_select ON %I.audit_events FOR SELECT TO renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id()))',s,s);
  EXECUTE format('CREATE POLICY audit_invariant_insert ON %I.audit_events FOR INSERT TO renyqo_workspace_invariants WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,s);
  EXECUTE format('CREATE POLICY audit_tenant_fence ON %I.audit_events AS RESTRICTIVE TO renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,s,s);
END $migration$;
COMMIT;
