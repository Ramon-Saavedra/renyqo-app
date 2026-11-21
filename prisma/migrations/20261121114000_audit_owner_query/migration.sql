BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.query_workspace_audit(w uuid,principal uuid,sid text,version integer,
      page_limit integer,before_time timestamptz,before_id uuid) RETURNS TABLE(event jsonb)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      PERFORM %1$I.assert_workspace_tenant(w);
      IF NOT coalesce(%1$I.audit_human_valid(principal,version,'SESSION_BOUND',sid),false)
        OR NOT EXISTS(SELECT FROM %1$I.workspace_memberships WHERE workspace_id=w AND user_id=principal AND status='ACTIVE' AND role='OWNER')
        OR page_limit IS NULL OR page_limit<1 OR page_limit>101
        OR (before_time IS NULL)<>(before_id IS NULL) OR (before_time IS NOT NULL AND NOT isfinite(before_time))
        THEN RAISE EXCEPTION 'Audit query unavailable' USING ERRCODE='42501';END IF;
      RETURN QUERY SELECT jsonb_build_object('id',e.id,'action',e.action,'recordedAt',e.recorded_at,
        'occurredAt',e.occurred_at,'source',e.source,'resourceType',e.resource_type,'resourceId',e.resource_id,
        'commandId',e.command_id,'effectKey',e.effect_key,
        'correlationId',e.correlation_id,'causationId',e.causation_id,
        -- USER evidence never turns this OWNER-only infrastructure reader into
        -- a bypass of WAITING anonymity or a broad applicant/profile projection.
        'actor',CASE WHEN e.actor_kind='MEMBER' AND i.id IS NOT NULL THEN jsonb_build_object(
          'kind',e.actor_kind,'name',i.snapshot->>'actorDisplayNameAtTime',
          'role',i.snapshot->>'actorRoleAtTime','color',i.snapshot->>'actorColorAtTime')
          ELSE jsonb_build_object('kind',e.actor_kind) END)
      FROM %1$I.audit_events e LEFT JOIN %1$I.audit_actor_identities i ON i.id=e.actor_identity_id AND i.workspace_id=e.workspace_id
      WHERE e.workspace_id=w AND (before_time IS NULL OR (e.recorded_at,e.id)<(before_time,before_id))
      ORDER BY e.recorded_at DESC,e.id DESC LIMIT page_limit;
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) TO renyqo_workspace_runtime',s);
END $migration$;
COMMIT;
