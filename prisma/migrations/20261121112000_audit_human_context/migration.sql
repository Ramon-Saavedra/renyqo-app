BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format('GRANT SELECT,UPDATE(sid) ON %I.session_auth_grants TO renyqo_workspace_invariants',s);
  EXECUTE format('GRANT SELECT ON %I.user_sessions TO renyqo_workspace_invariants',s);
  EXECUTE format('GRANT UPDATE(id) ON %I.users TO renyqo_workspace_invariants',s);
  EXECUTE format('GRANT SELECT(applicant_id) ON %I.applications TO renyqo_workspace_invariants',s);
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.audit_human_valid(principal uuid,version integer,mode text,sid text) RETURNS boolean
    LANGUAGE sql VOLATILE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
      SELECT EXISTS(SELECT FROM %1$I.users WHERE id=principal AND status='active' AND auth_version=version)
        AND ((mode='USER_DELEGATED' AND sid IS NULL) OR (mode='SESSION_BOUND' AND EXISTS(
          SELECT FROM %1$I.session_auth_grants g JOIN %1$I.user_sessions s ON s.sid=g.sid
          WHERE g.sid=$4 AND g.user_id=principal AND g.auth_version=version AND s.expire>clock_timestamp()
          AND s.sess::jsonb->'passport'->'user'->>'id'=principal::text
          AND s.sess::jsonb->'passport'->'user'->'authVersion'=to_jsonb(version))))
    $fn$;
    CREATE FUNCTION %1$I.open_human_audit_execution(w uuid,principal uuid,version integer,mode text,sid text,
      member uuid,revision integer,application uuid,command jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE target uuid:=coalesce(w,%1$I.current_workspace_id()); presentation jsonb;kind %1$I."AuditActorKind";
    BEGIN
      -- A human runtime must not self-promote to a session-free delegated job.
      -- Closed future worker adapters may use server-derived delegation; no
      -- generic delegated/job credential infrastructure is activated here.
      IF mode='USER_DELEGATED' AND NOT pg_has_role(session_user,'renyqo_workspace_invariants','MEMBER')
        THEN PERFORM %1$I.reject_required_audit();END IF;
      -- Same canonical tiers as the existing coordinator. When called from its
      -- callback these exact locks are already held; no new participant is added.
      PERFORM id FROM %1$I.users WHERE id=principal FOR SHARE;
      IF mode='SESSION_BOUND' THEN PERFORM g.sid FROM %1$I.session_auth_grants g WHERE g.sid=open_human_audit_execution.sid FOR SHARE;END IF;
      PERFORM %1$I.assert_workspace_tenant(target);
      IF NOT coalesce(%1$I.audit_human_valid(principal,version,mode,sid),false) THEN PERFORM %1$I.reject_required_audit();END IF;
      PERFORM id FROM %1$I.provider_workspaces WHERE id=target AND lifecycle_status='ACTIVE' FOR SHARE;
      IF NOT FOUND THEN PERFORM %1$I.reject_required_audit();END IF;
      IF member IS NOT NULL THEN
        PERFORM m.id FROM %1$I.workspace_memberships m WHERE m.id=member AND m.workspace_id=target
          AND m.user_id=principal AND m.status='ACTIVE' AND m.revision=open_human_audit_execution.revision FOR SHARE;
        IF NOT FOUND OR application IS NOT NULL THEN PERFORM %1$I.reject_required_audit();END IF;
        kind:='MEMBER';presentation:=%1$I.evidence_member_actor_snapshot(target,member,principal);
      ELSE
        IF mode<>'SESSION_BOUND' OR application IS NULL OR NOT EXISTS(
          SELECT FROM %1$I.applications a JOIN %1$I.listings l ON l.id=a.listing_id
          WHERE a.id=application AND a.applicant_id=principal AND l.workspace_id=target)
          THEN PERFORM %1$I.reject_required_audit();END IF;
        kind:='USER';SELECT jsonb_build_object('snapshotVersion',1,'actorDisplayNameAtTime',name,
          'capturedAt',clock_timestamp()) INTO presentation FROM %1$I.users WHERE id=principal;
      END IF;
      IF NOT coalesce(%1$I.audit_human_valid(principal,version,mode,sid),false) THEN PERFORM %1$I.reject_required_audit();END IF;
      RETURN %1$I.create_audit_execution(target,kind,principal,member,NULL,presentation,
        CASE WHEN mode='USER_DELEGATED' THEN 'DOMAIN_WORKER'::%1$I."AuditSource" ELSE 'HTTP'::%1$I."AuditSource" END,command);
    END $fn$;
    CREATE FUNCTION %1$I.open_system_audit_execution(w uuid,purpose text,command jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    BEGIN
      IF purpose IS DISTINCT FROM 'AUDIT_LEDGER_ACTIVATION' THEN PERFORM %1$I.reject_required_audit();END IF;
      RETURN %1$I.create_audit_execution(w,'SYSTEM',NULL,NULL,purpose,NULL,'DOMAIN_WORKER',command);
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.open_human_audit_execution(uuid,uuid,integer,text,text,uuid,integer,uuid,jsonb) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_human_valid(uuid,integer,text,text),%I.open_human_audit_execution(uuid,uuid,integer,text,text,uuid,integer,uuid,jsonb),%I.open_system_audit_execution(uuid,text,jsonb) FROM PUBLIC,renyqo_workspace_runtime',s,s,s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_human_valid(uuid,integer,text,text),%I.open_system_audit_execution(uuid,text,jsonb) TO renyqo_workspace_invariants',s,s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.open_human_audit_execution(uuid,uuid,integer,text,text,uuid,integer,uuid,jsonb) TO renyqo_workspace_runtime',s);
END $migration$;
COMMIT;
