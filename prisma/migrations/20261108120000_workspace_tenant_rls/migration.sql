BEGIN;

-- Cluster roles have no login credentials. Deployment must have CREATEROLE or
-- pre-provision these exact restricted roles; application credentials never do.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='renyqo_workspace_runtime') THEN
    CREATE ROLE renyqo_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='renyqo_workspace_invariants') THEN
    CREATE ROLE renyqo_workspace_invariants NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='renyqo_workspace_owner') THEN
    CREATE ROLE renyqo_workspace_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN
    ('renyqo_workspace_runtime','renyqo_workspace_invariants','renyqo_workspace_owner') AND
    (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'Unsafe workspace role attributes';
  END IF;
END $$;

-- Schema-qualified policies, including a restrictive fence: adding another
-- permissive policy cannot widen ordinary access beyond this tenant boundary.
DO $$ DECLARE s text := current_schema(); t text; key_column text; predicate text;
BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', s);
  EXECUTE format('GRANT renyqo_workspace_owner TO %I', current_user);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO renyqo_workspace_owner', s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO renyqo_workspace_runtime, renyqo_workspace_invariants', s);
  FOREACH t IN ARRAY ARRAY['provider_workspaces','workspace_memberships','organization_profiles',
    'ownership_transfer_intents','personal_workspace_allocations','workspace_ownership_revision_baselines'] LOOP
    key_column := CASE WHEN t='provider_workspaces' THEN 'id' ELSE 'workspace_id' END;
    predicate := format('%I = (SELECT %I.current_workspace_id())', key_column, s);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s,t);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', s,t);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner', s,t);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, renyqo_workspace_runtime', s,t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO renyqo_workspace_invariants', s,t);
    EXECUTE format('CREATE POLICY invariant_tenant ON %I.%I TO renyqo_workspace_invariants USING (%s) WITH CHECK (%s)',s,t,predicate,predicate);
    IF t <> 'workspace_ownership_revision_baselines' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO renyqo_workspace_runtime', s,t);
      EXECUTE format('CREATE POLICY tenant_insert ON %I.%I FOR INSERT TO renyqo_workspace_runtime WITH CHECK (%s)',s,t,predicate);
      EXECUTE format('CREATE POLICY tenant_update ON %I.%I FOR UPDATE TO renyqo_workspace_runtime USING (%s) WITH CHECK (%s)',s,t,predicate,predicate);
      EXECUTE format('CREATE POLICY tenant_write_fence ON %I.%I AS RESTRICTIVE FOR ALL TO renyqo_workspace_runtime USING (%s) WITH CHECK (%s)',
        s,t,CASE WHEN t='workspace_memberships' THEN format('(%s) OR (%I.current_workspace_id() IS NULL AND workspace_id=%I.workspace_context_uuid(''app.bootstrap_workspace_id'') AND user_id=%I.workspace_context_uuid(''app.bootstrap_user_id''))',predicate,s,s,s) ELSE predicate END,predicate);
      EXECUTE format('CREATE POLICY tenant_select ON %I.%I FOR SELECT TO renyqo_workspace_runtime USING (%s)',s,t,predicate);
    END IF;
  END LOOP;
  EXECUTE format('CREATE POLICY own_candidate_bootstrap ON %I.workspace_memberships FOR SELECT TO renyqo_workspace_runtime USING
    (%I.current_workspace_id() IS NULL AND workspace_id=%I.workspace_context_uuid(''app.bootstrap_workspace_id'')
      AND user_id=%I.workspace_context_uuid(''app.bootstrap_user_id''))',s,s,s,s);
  EXECUTE format('GRANT SELECT ON %I.users TO renyqo_workspace_invariants', s);
END $$;

-- Harden the EXISTING invariant chain without changing its domain algorithm.
-- Qualify relation/type/helper tokens, preserving quoted SQL string literals.
-- Every helper rejects absent/wrong context before any privileged work.
DO $$
DECLARE s text := current_schema(); f record; source text; hardened text; token text;
  definition text; assertion text;
  helpers text[] := ARRAY['lock_workspace_structure','guard_provider_workspace',
    'guard_workspace_membership_identity','guard_organization_profile','guard_personal_allocation',
    'release_closed_workspace_allocations','check_workspace_structure','guard_workspace_ownership_baseline',
    'capture_workspace_ownership_baseline','initialize_workspace_ownership_baseline',
    'assert_workspace_ownership_revision','lock_workspace_ownership_revision',
    'finalize_workspace_ownership_revision','guard_ownership_transfer_intent'];
  objects text[];
BEGIN
  objects := helpers || ARRAY['provider_workspaces','workspace_memberships','organization_profiles',
    'personal_workspace_allocations','workspace_ownership_revision_baselines','ownership_transfer_intents','users',
    'WorkspaceKind','WorkspaceLifecycle','WorkspaceMembershipRole','PersonalAllocationReleaseReason',
    'WorkspaceMembershipStatus','OwnershipTransferOutcome','OwnershipTransferIntentStatus'];
  -- ALTER OWNER requires membership for a non-superuser deployment role.
  EXECUTE format('GRANT renyqo_workspace_invariants TO %I', current_user);
  FOR f IN SELECT p.oid,p.proname,p.prosrc,p.prorettype FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=s AND p.proname=ANY(helpers) LOOP
    source := ''; hardened := '';
    FOR token IN SELECT (m)[1] FROM regexp_matches(f.prosrc,
      $rx$('(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|.)$rx$, 'gs') m LOOP
      IF trim(both '"' from token)=ANY(objects) AND left(token,1)<>'''' THEN
        source := source || format('%I.%s',s,token);
      ELSE source := source || token; END IF;
    END LOOP;
    assertion := CASE WHEN f.prorettype='trigger'::regtype THEN
      format('PERFORM %I.assert_workspace_tenant(CASE WHEN TG_TABLE_NAME=''provider_workspaces'' THEN
        (to_jsonb(CASE WHEN TG_OP=''DELETE'' THEN OLD ELSE NEW END)->>''id'')::uuid ELSE
        (to_jsonb(CASE WHEN TG_OP=''DELETE'' THEN OLD ELSE NEW END)->>''workspace_id'')::uuid END);',s)
      ELSE format('PERFORM %I.assert_workspace_tenant(target);',s) END;
    hardened := regexp_replace(source,'\mBEGIN\M','BEGIN ' || assertion);
    definition := replace(pg_get_functiondef(f.oid),f.prosrc,hardened);
    EXECUTE definition;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I, pg_temp',f.oid::regprocedure,s);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',f.oid::regprocedure);
    EXECUTE format('ALTER FUNCTION %s OWNER TO renyqo_workspace_invariants',f.oid::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, renyqo_workspace_runtime',f.oid::regprocedure);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.lock_workspace_ownership_revision(uuid,integer) TO renyqo_workspace_runtime',s);
  -- Context functions have no privileged access. Pin resolution and remove the
  -- default PUBLIC execution grant nevertheless.
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=s AND p.proname=ANY(ARRAY['workspace_context_uuid','current_workspace_id','assert_workspace_tenant']) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I, pg_temp',f.oid::regprocedure,s);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.oid::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO renyqo_workspace_runtime, renyqo_workspace_invariants',f.oid::regprocedure);
  END LOOP;
END $$;

COMMIT;
