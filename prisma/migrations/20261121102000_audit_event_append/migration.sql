BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.append_audit_event(event jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE actor jsonb:=event->'actor'; result uuid; k text;
    BEGIN
      IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR EXISTS(
        SELECT FROM jsonb_object_keys(event) key WHERE key<>ALL(ARRAY[
          'id','workspaceId','action','schemaVersion','actor','resourceType','resourceId',
          'occurredAt','source','correlationId','causationId','commandId','commandScope',
          'effectKey','changes','metadata'])) THEN
        RAISE EXCEPTION 'Invalid audit envelope' USING ERRCODE='23514';
      END IF;
      FOREACH k IN ARRAY ARRAY['id','workspaceId','action','resourceType','resourceId','occurredAt',
        'source','correlationId','commandId','commandScope','effectKey'] LOOP
        IF jsonb_typeof(event->k) IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Invalid audit envelope' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF jsonb_typeof(event->'schemaVersion') IS DISTINCT FROM 'number'
        OR jsonb_typeof(actor) IS DISTINCT FROM 'object'
        OR (event ? 'causationId' AND jsonb_typeof(event->'causationId')<>'string')
        OR EXISTS(SELECT FROM jsonb_object_keys(actor) key WHERE key<>ALL(
          CASE actor->>'kind' WHEN 'SYSTEM' THEN ARRAY['kind','purpose']
          WHEN 'USER' THEN ARRAY['kind','userId'] ELSE ARRAY['kind','userId','membershipId'] END)) THEN
        RAISE EXCEPTION 'Invalid audit envelope' USING ERRCODE='23514';
      END IF;
      FOREACH k IN ARRAY ARRAY['kind','userId','membershipId','purpose'] LOOP
        IF actor ? k AND jsonb_typeof(actor->k)<>'string' THEN
          RAISE EXCEPTION 'Invalid audit actor' USING ERRCODE='23514';
        END IF;
      END LOOP;
      INSERT INTO %1$I.audit_events(id,workspace_id,action,schema_version,actor_kind,actor_user_id,
        actor_membership_id,system_purpose,resource_type,resource_id,occurred_at,source,
        correlation_id,causation_id,command_id,command_scope,effect_key,changes,metadata)
      VALUES((event->>'id')::uuid,(event->>'workspaceId')::uuid,event->>'action',
        (event->>'schemaVersion')::integer,(actor->>'kind')::%1$I."AuditActorKind",
        (actor->>'userId')::uuid,(actor->>'membershipId')::uuid,actor->>'purpose',
        event->>'resourceType',(event->>'resourceId')::uuid,(event->>'occurredAt')::timestamptz,
        (event->>'source')::%1$I."AuditSource",(event->>'correlationId')::uuid,
        (event->>'causationId')::uuid,(event->>'commandId')::uuid,event->>'commandScope',
        event->>'effectKey',event->'changes',event->'metadata') RETURNING id INTO result;
      RETURN result;
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.append_audit_event(jsonb) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.append_audit_event(jsonb) FROM PUBLIC,renyqo_workspace_runtime',s);
  -- This is deliberately not a runtime callable SECURITY DEFINER append API.
  -- Future domain adoption must define and review its own authority boundary.
END $migration$;
COMMIT;
