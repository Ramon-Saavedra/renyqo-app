BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.append_context_audit_event(context uuid,effect text,changes jsonb,metadata jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE c %1$I.audit_execution_contexts;result uuid:=gen_random_uuid();
    BEGIN
      SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
      IF NOT FOUND OR NOT(effect=ANY(c.required_effects)) THEN PERFORM %1$I.reject_required_audit();END IF;
      PERFORM %1$I.assert_workspace_tenant(c.workspace_id);
      INSERT INTO %1$I.audit_actor_identities VALUES(c.id,c.workspace_id,c.actor_kind,c.actor_user_id,
        c.actor_membership_id,c.snapshot,c.captured_at) ON CONFLICT(id) DO NOTHING;
      IF NOT EXISTS(SELECT FROM %1$I.audit_actor_identities i WHERE i.id=c.id
        AND (i.workspace_id,i.actor_kind,i.actor_user_id,i.actor_membership_id,i.snapshot,i.captured_at)
          IS NOT DISTINCT FROM (c.workspace_id,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.snapshot,c.captured_at))
        THEN PERFORM %1$I.reject_required_audit();END IF;
      INSERT INTO %1$I.audit_events(id,workspace_id,action,schema_version,actor_kind,actor_user_id,
        actor_membership_id,system_purpose,resource_type,resource_id,occurred_at,source,correlation_id,
        causation_id,command_id,command_scope,effect_key,changes,metadata,actor_identity_id)
      VALUES(result,c.workspace_id,'audit.ledger.activated',1,c.actor_kind,c.actor_user_id,c.actor_membership_id,
        c.system_purpose,'WORKSPACE',c.workspace_id,clock_timestamp(),c.source,c.correlation_id,c.causation_id,
        c.command_id,c.command_scope,effect,changes,metadata,c.id);
      RETURN result;
    END $fn$;
    CREATE FUNCTION %1$I.close_audit_execution(context uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE c %1$I.audit_execution_contexts;
    BEGIN
      SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
      IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
      PERFORM %1$I.assert_workspace_tenant(c.workspace_id);
      IF EXISTS(SELECT FROM unnest(c.required_effects) effect WHERE NOT EXISTS(
        SELECT FROM %1$I.audit_events e WHERE e.actor_identity_id=c.id AND e.effect_key=effect))
        THEN PERFORM %1$I.reject_required_audit();END IF;
      DELETE FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
    END $fn$;
    CREATE FUNCTION %1$I.assert_audit_execution_complete() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      IF EXISTS(SELECT FROM %1$I.audit_execution_contexts WHERE transaction_id=pg_current_xact_id()::text)
        THEN PERFORM %1$I.reject_required_audit();END IF;
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.append_context_audit_event(uuid,text,jsonb,jsonb) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('ALTER FUNCTION %I.close_audit_execution(uuid) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.append_context_audit_event(uuid,text,jsonb,jsonb),%I.close_audit_execution(uuid) FROM PUBLIC',s,s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.append_context_audit_event(uuid,text,jsonb,jsonb),%I.close_audit_execution(uuid) TO renyqo_workspace_runtime',s,s);
  EXECUTE format('ALTER FUNCTION %I.assert_audit_execution_complete() OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.assert_audit_execution_complete() FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.assert_audit_execution_complete() TO renyqo_workspace_runtime',s);
END $migration$;
COMMIT;
