BEGIN;

CREATE TABLE audit_profile_scopes(id uuid PRIMARY KEY,transaction_id varchar(20) NOT NULL,user_id uuid NOT NULL,listing_ids uuid[] NOT NULL,workspace_ids uuid[] NOT NULL);
CREATE TABLE audit_profile_bindings(context_id uuid PRIMARY KEY,scope_id uuid NOT NULL);
CREATE INDEX audit_profile_binding_scope ON audit_profile_bindings(scope_id);
DO $migration$ DECLARE s text:=current_schema(); t text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit_profile_scopes','audit_profile_bindings'] LOOP
  EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner',s,t);
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,renyqo_workspace_runtime,renyqo_workspace_invariants',s,t);
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON %I.%I TO renyqo_workspace_invariants',s,t);
 END LOOP;
 EXECUTE format('CREATE POLICY audit_profile_scope_xid ON %I.audit_profile_scopes TO renyqo_workspace_invariants USING(transaction_id=pg_current_xact_id()::text) WITH CHECK(transaction_id=pg_current_xact_id()::text)',s);
 EXECUTE format('CREATE POLICY audit_profile_binding_xid ON %1$I.audit_profile_bindings TO renyqo_workspace_invariants USING(EXISTS(SELECT FROM %1$I.audit_profile_scopes p WHERE p.id=scope_id)) WITH CHECK(EXISTS(SELECT FROM %1$I.audit_profile_scopes p WHERE p.id=scope_id))',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_workspace_allowed(w uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
  SELECT CASE WHEN nullif(current_setting('app.workspace_id',true),'') IS NOT NULL THEN w=%1$I.current_workspace_id()
   ELSE EXISTS(SELECT FROM %1$I.audit_profile_scopes p WHERE p.transaction_id=pg_current_xact_id()::text AND w=ANY(p.workspace_ids)) END
 $fn$;
 CREATE FUNCTION %1$I.assert_audit_scope(c %1$I.audit_execution_contexts) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN
  IF EXISTS(SELECT FROM %1$I.audit_profile_bindings b JOIN %1$I.audit_profile_scopes p ON p.id=b.scope_id
   WHERE b.context_id=c.id AND p.transaction_id=pg_current_xact_id()::text AND c.workspace_id=ANY(p.workspace_ids)) THEN
   IF nullif(current_setting('app.workspace_id',true),'') IS NOT NULL THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSE PERFORM %1$I.assert_workspace_tenant(c.workspace_id);END IF;
 END $fn$;
 CREATE FUNCTION %1$I.audit_profile_scope_closed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN
  IF EXISTS(SELECT FROM %1$I.audit_profile_scopes WHERE id=NEW.id) THEN PERFORM %1$I.reject_required_audit();END IF;RETURN NULL;
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.audit_profile_scope_closed() OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('CREATE CONSTRAINT TRIGGER audit_profile_scope_closed AFTER INSERT ON %1$I.audit_profile_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %1$I.audit_profile_scope_closed()',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %1$I.audit_workspace_allowed(uuid),%1$I.assert_audit_scope(%1$I.audit_execution_contexts),%1$I.audit_profile_scope_closed() FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.audit_workspace_allowed(uuid),%1$I.assert_audit_scope(%1$I.audit_execution_contexts) TO renyqo_workspace_invariants',s);
 EXECUTE format('DROP POLICY audit_identity_tenant ON %I.audit_actor_identities',s);
 EXECUTE format('CREATE POLICY audit_identity_tenant ON %1$I.audit_actor_identities TO renyqo_workspace_invariants USING(%1$I.audit_workspace_allowed(workspace_id)) WITH CHECK(%1$I.audit_workspace_allowed(workspace_id))',s);
 EXECUTE format('ALTER POLICY audit_invariant_select ON %1$I.audit_events USING(%1$I.audit_workspace_allowed(workspace_id))',s);
 EXECUTE format('ALTER POLICY audit_invariant_insert ON %1$I.audit_events WITH CHECK(%1$I.audit_workspace_allowed(workspace_id))',s);
 EXECUTE format('ALTER POLICY audit_tenant_fence ON %1$I.audit_events USING(%1$I.audit_workspace_allowed(workspace_id)) WITH CHECK(%1$I.audit_workspace_allowed(workspace_id))',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('GRANT SELECT ON %I.listing_tenant_routes TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.lock_profile_revalidation_listings(uuid) TO renyqo_workspace_invariants',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.open_profile_audit_scope(principal uuid,version integer,sid text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE result uuid:=gen_random_uuid(); listings uuid[];workspaces uuid[];
 BEGIN
  IF nullif(current_setting('app.workspace_id',true),'') IS NOT NULL THEN PERFORM %1$I.reject_required_audit();END IF;
  PERFORM id FROM %1$I.users WHERE id=principal AND role='applicant' FOR SHARE;
  IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
  PERFORM g.sid FROM %1$I.session_auth_grants g WHERE g.sid=open_profile_audit_scope.sid FOR SHARE;
  IF NOT coalesce(%1$I.audit_human_valid(principal,version,'SESSION_BOUND',sid),false) THEN PERFORM %1$I.reject_required_audit();END IF;
  SELECT coalesce(array_agg(l.id ORDER BY l.id),'{}'::uuid[]) INTO listings FROM %1$I.lock_profile_revalidation_listings(principal) l;
  SELECT coalesce(array_agg(DISTINCT r.workspace_id ORDER BY r.workspace_id),'{}'::uuid[]) INTO workspaces FROM %1$I.listing_tenant_routes r WHERE r.listing_id=ANY(listings);
  IF NOT coalesce(%1$I.audit_human_valid(principal,version,'SESSION_BOUND',sid),false) THEN PERFORM %1$I.reject_required_audit();END IF;
  INSERT INTO %1$I.audit_profile_scopes VALUES(result,pg_current_xact_id()::text,principal,listings,workspaces);
  RETURN result;
 END $fn$;
 CREATE FUNCTION %1$I.close_profile_audit_scope(scope uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN
  IF EXISTS(SELECT FROM %1$I.audit_profile_bindings WHERE scope_id=scope) THEN PERFORM %1$I.reject_required_audit();END IF;
  DELETE FROM %1$I.audit_profile_scopes WHERE id=scope AND transaction_id=pg_current_xact_id()::text;
  IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.open_profile_audit_scope(uuid,integer,text) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('ALTER FUNCTION %I.close_profile_audit_scope(uuid) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %1$I.open_profile_audit_scope(uuid,integer,text),%1$I.close_profile_audit_scope(uuid) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.open_profile_audit_scope(uuid,integer,text),%1$I.close_profile_audit_scope(uuid) TO renyqo_workspace_runtime',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.close_audit_execution(context uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE c %1$I.audit_execution_contexts;
    BEGIN
      SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
      IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
      PERFORM %1$I.assert_audit_scope(c);
      IF EXISTS(SELECT FROM unnest(c.required_effects) effect WHERE NOT EXISTS(
        SELECT FROM %1$I.audit_events e WHERE e.actor_identity_id=c.id AND e.effect_key=effect))
        THEN PERFORM %1$I.reject_required_audit();END IF;
      DELETE FROM %1$I.audit_profile_bindings WHERE context_id=context;
      DELETE FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
    END $fn$;
 $ddl$,s);
END $migration$;

-- Full top-level xid provenance, not xmin/32-bit comparisons or timestamp guesses.
-- No payload, identity snapshot, authority epoch or durable domain history here.
CREATE TABLE audit_activity_sources(activity_id uuid PRIMARY KEY,transaction_id varchar(20) NOT NULL);
CREATE INDEX audit_activity_source_transaction ON audit_activity_sources(transaction_id,activity_id);
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('ALTER TABLE %I.audit_activity_sources OWNER TO renyqo_workspace_owner',s);
 EXECUTE format('ALTER TABLE %I.audit_activity_sources ENABLE ROW LEVEL SECURITY',s);
 EXECUTE format('ALTER TABLE %I.audit_activity_sources FORCE ROW LEVEL SECURITY',s);
 EXECUTE format('REVOKE ALL ON %I.audit_activity_sources FROM PUBLIC,renyqo_workspace_runtime,renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT,INSERT,DELETE ON %I.audit_activity_sources TO renyqo_workspace_invariants',s);
 EXECUTE format('CREATE POLICY audit_activity_source_xid ON %I.audit_activity_sources TO renyqo_workspace_invariants USING(transaction_id=pg_current_xact_id()::text) WITH CHECK(transaction_id=pg_current_xact_id()::text)',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.capture_audit_activity_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN
  IF NEW.type::text IN('application_submitted','application_withdrawn','application_rejected','application_restored','application_promoted_to_active','application_accepted','viewing_consideration_changed') THEN
   INSERT INTO %1$I.audit_activity_sources VALUES(NEW.id,pg_current_xact_id()::text);
  END IF;RETURN NEW;
 END $fn$;
 CREATE FUNCTION %1$I.cleanup_audit_activity_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN DELETE FROM %1$I.audit_activity_sources WHERE activity_id=NEW.activity_id AND transaction_id=pg_current_xact_id()::text;RETURN NULL;END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.capture_audit_activity_source() OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('ALTER FUNCTION %I.cleanup_audit_activity_source() OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %1$I.capture_audit_activity_source(),%1$I.cleanup_audit_activity_source() FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('CREATE TRIGGER audit_activity_source AFTER INSERT ON %1$I.application_activities FOR EACH ROW EXECUTE FUNCTION %1$I.capture_audit_activity_source()',s);
 EXECUTE format('CREATE CONSTRAINT TRIGGER audit_activity_source_cleanup AFTER INSERT ON %1$I.audit_activity_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %1$I.cleanup_audit_activity_source()',s);
END $migration$;

-- Technical before/after proof, not durable business history or a state machine.
CREATE TABLE audit_application_changes(id uuid PRIMARY KEY,transaction_id varchar(20) NOT NULL,application_id uuid NOT NULL,previous_status varchar(20),new_status varchar(20) NOT NULL);
CREATE INDEX audit_application_change_tx_app ON audit_application_changes(transaction_id,application_id);
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('ALTER TABLE %I.audit_application_changes OWNER TO renyqo_workspace_owner',s);
 EXECUTE format('ALTER TABLE %I.audit_application_changes ENABLE ROW LEVEL SECURITY',s);
 EXECUTE format('ALTER TABLE %I.audit_application_changes FORCE ROW LEVEL SECURITY',s);
 EXECUTE format('REVOKE ALL ON %I.audit_application_changes FROM PUBLIC,renyqo_workspace_runtime,renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT,INSERT,DELETE ON %I.audit_application_changes TO renyqo_workspace_invariants',s);
 EXECUTE format('CREATE POLICY audit_application_change_xid ON %I.audit_application_changes TO renyqo_workspace_invariants USING(transaction_id=pg_current_xact_id()::text) WITH CHECK(transaction_id=pg_current_xact_id()::text)',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.capture_audit_application_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
   INSERT INTO %1$I.audit_application_changes VALUES(gen_random_uuid(),pg_current_xact_id()::text,NEW.id,
     CASE WHEN TG_OP='UPDATE' THEN upper(OLD.status::text) END,upper(NEW.status::text));
  END IF;RETURN NEW;
 END $fn$;
 CREATE FUNCTION %1$I.cleanup_audit_application_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 BEGIN DELETE FROM %1$I.audit_application_changes WHERE id=NEW.id AND transaction_id=pg_current_xact_id()::text;RETURN NULL;END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.capture_audit_application_change() OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('ALTER FUNCTION %I.cleanup_audit_application_change() OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %1$I.capture_audit_application_change(),%1$I.cleanup_audit_application_change() FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('CREATE TRIGGER audit_application_change AFTER INSERT OR UPDATE OF status ON %1$I.applications FOR EACH ROW EXECUTE FUNCTION %1$I.capture_audit_application_change()',s);
 EXECUTE format('CREATE CONSTRAINT TRIGGER audit_application_change_cleanup AFTER INSERT ON %1$I.audit_application_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %1$I.cleanup_audit_application_change()',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.guard_audit_event_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE c %1$I.audit_execution_contexts;
    BEGIN
      IF NEW.actor_kind='SYSTEM' AND NEW.command_scope='application.lifecycle.system' AND NEW.actor_identity_id IS NOT NULL THEN
        SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=NEW.actor_identity_id
          AND transaction_id=pg_current_xact_id()::text AND workspace_id=NEW.workspace_id
          AND actor_kind='SYSTEM' AND system_purpose=NEW.system_purpose;
        IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
        PERFORM %1$I.assert_audit_scope(c);
      ELSE PERFORM %1$I.assert_workspace_tenant(NEW.workspace_id);END IF;
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
 $ddl$,s);
END $migration$;

COMMIT;
