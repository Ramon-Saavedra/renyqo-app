BEGIN;

CREATE FUNCTION workspace_context_uuid(setting_name text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE value text;
BEGIN
  IF current_setting('app.tenant_xid', true) IS DISTINCT FROM pg_current_xact_id_if_assigned()::text
     OR pg_current_xact_id_if_assigned() IS NULL THEN RETURN NULL; END IF;
  value := current_setting(setting_name, true);
  IF value IS NULL OR value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN value::uuid;
END $$;

CREATE FUNCTION current_workspace_id() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
  AS $$ SELECT workspace_context_uuid('app.workspace_id') $$;
CREATE FUNCTION assert_workspace_tenant(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF target IS NULL OR target IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'Valid matching workspace transaction required' USING ERRCODE='42501';
  END IF;
END $$;

COMMIT;
