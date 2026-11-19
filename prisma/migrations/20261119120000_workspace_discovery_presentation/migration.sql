BEGIN;

-- Add one canonical presentation field to the existing self-discovery boundary.
-- PostgreSQL cannot replace a function with a different TABLE return type.
DO $$ DECLARE s text := current_schema();
BEGIN
  EXECUTE format('GRANT SELECT(display_name) ON %I.provider_workspaces TO renyqo_workspace_discovery', s);
  EXECUTE format('DROP FUNCTION %I.discover_active_workspaces(uuid)', s);
  EXECUTE format($sql$
    CREATE FUNCTION %1$I.discover_active_workspaces(authenticated_user uuid)
    RETURNS TABLE("workspaceId" uuid,"membershipId" uuid,role text,kind text,"displayName" text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE previous text:=current_setting('app.workspace_discovery_user',true);
    BEGIN
      PERFORM set_config('app.workspace_discovery_user',authenticated_user::text,true);
      RETURN QUERY SELECT w.id,m.id,m.role::text,w.kind::text,w.display_name::text
        FROM %1$I.workspace_memberships m JOIN %1$I.provider_workspaces w ON w.id=m.workspace_id
        WHERE m.user_id=authenticated_user AND m.status='ACTIVE' AND w.lifecycle_status='ACTIVE'
        ORDER BY w.id;
      PERFORM set_config('app.workspace_discovery_user',coalesce(previous,''),true);
    END $fn$;
  $sql$, s);
  EXECUTE format('ALTER FUNCTION %I.discover_active_workspaces(uuid) OWNER TO renyqo_workspace_discovery', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.discover_active_workspaces(uuid) FROM PUBLIC', s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.discover_active_workspaces(uuid) TO renyqo_workspace_runtime', s);
END $$;

COMMIT;
