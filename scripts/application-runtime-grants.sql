-- Called explicitly by provision-application-runtime.cjs after schema cutover.
-- Existing non-RLS domains keep their own authorization/invariant enforcement.
DO $$ DECLARE s text:=current_schema(); queue_sequence text; consideration_sequence text;
BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_application_runtime') THEN
    CREATE ROLE renyqo_application_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_application_runtime' AND
    (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'Unsafe application grant role';
  END IF;
  GRANT renyqo_workspace_runtime TO renyqo_application_runtime;
  IF EXISTS(SELECT FROM pg_roles p WHERE p.rolname NOT IN('renyqo_application_runtime','renyqo_workspace_runtime')
    AND pg_has_role('renyqo_application_runtime',p.oid,'MEMBER')) THEN
    RAISE EXCEPTION 'Unsafe application role graph';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO renyqo_application_runtime',s);
  -- Required by INSERT defaults, including the unchanged global queue sequence.
  -- No blanket sequence grants. The legacy consideration INSERT default still
  -- evaluates its serial sequence before the queue-fairness trigger derives position.
  queue_sequence:=pg_get_serial_sequence(format('%I.applications',s),'queue_order');
  IF queue_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO renyqo_application_runtime',queue_sequence);
  END IF;
  consideration_sequence:=pg_get_serial_sequence(format('%I.application_consideration_positions',s),'position');
  IF consideration_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO renyqo_application_runtime',consideration_sequence);
  END IF;
END $$;
