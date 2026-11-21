BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.reject_required_audit() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN RAISE EXCEPTION 'Required audit evidence unavailable' USING ERRCODE='23514'; END $fn$;
    CREATE FUNCTION %1$I.audit_command_valid(command jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
      SELECT coalesce(jsonb_typeof(command)='object' AND NOT EXISTS(
        SELECT FROM jsonb_object_keys(command) k WHERE k<>ALL(ARRAY['commandId','commandScope','correlationId','causationId','requiredEffects']))
        AND command->>'commandScope'='audit.ledger.activation'
        AND jsonb_typeof(command->'requiredEffects')='array'
        AND jsonb_array_length(command->'requiredEffects') BETWEEN 1 AND 32
        AND (SELECT count(*)=count(DISTINCT v) AND bool_and(jsonb_typeof(v)='string' AND (v#>>'{}')~'^[a-z][a-z0-9_.:-]{0,79}$') FROM jsonb_array_elements(command->'requiredEffects') v)
        AND jsonb_typeof(command->'commandId')='string' AND jsonb_typeof(command->'correlationId')='string'
        AND (NOT command ? 'causationId' OR jsonb_typeof(command->'causationId')='string'),false)
    $fn$;
    CREATE FUNCTION %1$I.create_audit_execution(w uuid,kind %1$I."AuditActorKind",principal uuid,member uuid,
      purpose text,snapshot jsonb,origin %1$I."AuditSource",command jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE result uuid:=gen_random_uuid();
    BEGIN
      PERFORM %1$I.assert_workspace_tenant(w);
      IF NOT %1$I.audit_command_valid(command) THEN PERFORM %1$I.reject_required_audit();END IF;
      INSERT INTO %1$I.audit_execution_contexts VALUES(result,w,pg_current_xact_id()::text,kind,principal,member,
        purpose,snapshot,clock_timestamp(),origin,(command->>'commandId')::uuid,command->>'commandScope',
        (command->>'correlationId')::uuid,(command->>'causationId')::uuid,
        ARRAY(SELECT jsonb_array_elements_text(command->'requiredEffects')));
      RETURN result;
    END $fn$;
    CREATE FUNCTION %1$I.assert_audit_execution_closed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      IF EXISTS(SELECT FROM %1$I.audit_execution_contexts WHERE id=NEW.id AND transaction_id=pg_current_xact_id()::text)
        THEN PERFORM %1$I.reject_required_audit();END IF;
      RETURN NULL;
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.assert_audit_execution_closed() OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('CREATE CONSTRAINT TRIGGER audit_execution_closed AFTER INSERT ON %I.audit_execution_contexts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %I.assert_audit_execution_closed()',s,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.reject_required_audit(),%I.audit_command_valid(jsonb),%I.create_audit_execution(uuid,%I."AuditActorKind",uuid,uuid,text,jsonb,%I."AuditSource",jsonb),%I.assert_audit_execution_closed() FROM PUBLIC,renyqo_workspace_runtime',s,s,s,s,s,s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.reject_required_audit() TO renyqo_workspace_runtime,renyqo_workspace_invariants',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_command_valid(jsonb),%I.create_audit_execution(uuid,%I."AuditActorKind",uuid,uuid,text,jsonb,%I."AuditSource",jsonb) TO renyqo_workspace_invariants',s,s,s,s);
END $migration$;
COMMIT;
