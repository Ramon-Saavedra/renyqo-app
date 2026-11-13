BEGIN;

-- Read-only self-discovery. Ordinary tenant/bootstrap policies are unchanged.
DO $$ DECLARE s text:=current_schema(); predicate text;
BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_workspace_discovery') THEN
    CREATE ROLE renyqo_workspace_discovery NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_workspace_discovery'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) OR
    EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='renyqo_workspace_discovery')) THEN
    RAISE EXCEPTION 'Unsafe workspace discovery helper role';
  END IF;
  EXECUTE format('GRANT renyqo_workspace_discovery TO %I',current_user);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO renyqo_workspace_discovery',s);
  EXECUTE format('GRANT SELECT(id,workspace_id,user_id,role,status) ON %I.workspace_memberships TO renyqo_workspace_discovery',s);
  EXECUTE format('GRANT SELECT(id,kind,lifecycle_status) ON %I.provider_workspaces TO renyqo_workspace_discovery',s);
  predicate:='user_id=nullif(current_setting(''app.workspace_discovery_user'',true),'''')::uuid AND status=''ACTIVE''';
  EXECUTE format('CREATE POLICY workspace_self_discovery ON %I.workspace_memberships FOR SELECT TO renyqo_workspace_discovery USING(%s)',s,predicate);
  predicate:=format('lifecycle_status=''ACTIVE'' AND EXISTS(SELECT FROM %I.workspace_memberships m WHERE m.workspace_id=provider_workspaces.id)',s);
  EXECUTE format('CREATE POLICY workspace_self_discovery ON %I.provider_workspaces FOR SELECT TO renyqo_workspace_discovery USING(%s)',s,predicate);
  EXECUTE format($sql$
    CREATE FUNCTION %1$I.discover_active_workspaces(authenticated_user uuid)
    RETURNS TABLE("workspaceId" uuid,"membershipId" uuid,role text,kind text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE previous text:=current_setting('app.workspace_discovery_user',true);
    BEGIN
      PERFORM set_config('app.workspace_discovery_user',authenticated_user::text,true);
      RETURN QUERY SELECT w.id,m.id,m.role::text,w.kind::text
        FROM %1$I.workspace_memberships m JOIN %1$I.provider_workspaces w ON w.id=m.workspace_id
        WHERE m.user_id=authenticated_user AND m.status='ACTIVE' AND w.lifecycle_status='ACTIVE'
        ORDER BY w.id;
      PERFORM set_config('app.workspace_discovery_user',coalesce(previous,''),true);
    END $fn$;
  $sql$,s);
  EXECUTE format('ALTER FUNCTION %I.discover_active_workspaces(uuid) OWNER TO renyqo_workspace_discovery',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.discover_active_workspaces(uuid) FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.discover_active_workspaces(uuid) TO renyqo_workspace_runtime',s);
END $$;

COMMIT;
