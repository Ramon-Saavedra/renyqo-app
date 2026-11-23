BEGIN;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.append_lifecycle_audit_event(context uuid,effect text,t jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE c %1$I.audit_execution_contexts;e jsonb;result uuid:=gen_random_uuid();evidence uuid;purpose text;
 BEGIN
  SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
  IF NOT FOUND OR NOT(effect=ANY(c.required_effects)) THEN PERFORM %1$I.reject_required_audit();END IF;
  PERFORM %1$I.assert_audit_scope(c);
  IF t->>'kind'='LISTING_STATE' THEN
   e:=%1$I.audit_listing_evidence(c,t);
   IF effect IS DISTINCT FROM 'listing.state:'||(e->>'resourceId') THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSIF t->>'kind'='APPLICATION_ACTIVITY' AND (t-ARRAY['kind','activityId'])='{}'::jsonb THEN
   evidence:=(t->>'activityId')::uuid;e:=%1$I.audit_application_evidence(evidence);
   IF e IS NULL OR (e->>'workspaceId')::uuid<>c.workspace_id OR effect IS DISTINCT FROM 'application.activity:'||evidence::text
    OR c.command_scope NOT IN('application.lifecycle','application.lifecycle.system') THEN PERFORM %1$I.reject_required_audit();END IF;
   IF c.actor_kind='USER' THEN
    IF e->>'actorType'<>'APPLICANT' OR (e->>'actorUserId')::uuid IS DISTINCT FROM c.actor_user_id
     OR (e->>'applicantId')::uuid IS DISTINCT FROM c.actor_user_id THEN PERFORM %1$I.reject_required_audit();END IF;
   ELSIF c.actor_kind='MEMBER' THEN
    IF e->>'actorType'<>'PROVIDER' OR (e->>'actorUserId')::uuid IS DISTINCT FROM c.actor_user_id
     OR NOT EXISTS(SELECT FROM %1$I.listings WHERE id=(e->>'listingId')::uuid AND workspace_id=c.workspace_id
      AND (c.snapshot->>'actorRoleAtTime'='OWNER' OR responsible_membership_id=c.actor_membership_id)) THEN PERFORM %1$I.reject_required_audit();END IF;
   ELSIF c.actor_kind='SYSTEM' THEN
    IF e->>'actorType'<>'SYSTEM' OR c.causation_id IS DISTINCT FROM evidence OR c.system_purpose NOT IN(
     'APPLICATION_QUEUE_RECONCILIATION','APPLICATION_ELIGIBILITY_REVALIDATION','APPLICATION_VIEWING_INTEREST_EXPIRY') THEN PERFORM %1$I.reject_required_audit();END IF;
   ELSE PERFORM %1$I.reject_required_audit();END IF;
   e:=e||jsonb_build_object('resourceType','APPLICATION');
  ELSE PERFORM %1$I.reject_required_audit();END IF;
  IF e IS NULL THEN PERFORM %1$I.reject_required_audit();END IF;
  INSERT INTO %1$I.audit_actor_identities VALUES(c.id,c.workspace_id,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.snapshot,c.captured_at) ON CONFLICT(id) DO NOTHING;
  IF NOT EXISTS(SELECT FROM %1$I.audit_actor_identities i WHERE i.id=c.id AND
   (i.workspace_id,i.actor_kind,i.actor_user_id,i.actor_membership_id,i.snapshot,i.captured_at) IS NOT DISTINCT FROM
   (c.workspace_id,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.snapshot,c.captured_at)) THEN PERFORM %1$I.reject_required_audit();END IF;
  INSERT INTO %1$I.audit_events(id,workspace_id,action,schema_version,actor_kind,actor_user_id,actor_membership_id,system_purpose,
   resource_type,resource_id,listing_id,resource_revision_before,resource_revision_after,revision_kind,occurred_at,source,correlation_id,causation_id,
   command_id,command_scope,effect_key,source_evidence_type,source_evidence_id,changes,metadata,actor_identity_id)
  VALUES(result,c.workspace_id,e->>'action',1,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.system_purpose,
   e->>'resourceType',(e->>'resourceId')::uuid,(e->>'listingId')::uuid,(e->>'revisionBefore')::integer,(e->>'revisionAfter')::integer,
   CASE WHEN evidence IS NULL THEN 'LISTING' END,(e->>'occurredAt')::timestamptz,c.source,c.correlation_id,c.causation_id,
   c.command_id,c.command_scope,effect,CASE WHEN evidence IS NOT NULL THEN 'APPLICATION_ACTIVITY' END,evidence,e->'changes','{}',c.id);
  RETURN result;
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.append_lifecycle_audit_event(uuid,text,jsonb) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.append_lifecycle_audit_event(uuid,text,jsonb) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.append_lifecycle_audit_event(uuid,text,jsonb) TO renyqo_workspace_runtime',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.query_workspace_audit(w uuid,principal uuid,sid text,version integer,
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
      WHERE e.workspace_id=w AND (e.resource_type<>'APPLICATION' OR EXISTS(SELECT FROM %1$I.application_activities a WHERE a.id=e.source_evidence_id AND a.visibility IN('both','provider'))) AND (before_time IS NULL OR (e.recorded_at,e.id)<(before_time,before_id))
      ORDER BY e.recorded_at DESC,e.id DESC LIMIT page_limit;
    END $fn$;
  $ddl$,s);
  EXECUTE format('ALTER FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid) TO renyqo_workspace_runtime',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.open_human_audit_execution(w uuid,principal uuid,version integer,mode text,sid text,
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
        kind:='USER';SELECT jsonb_build_object('snapshotVersion',1,'actorDisplayNameAtTime',CASE WHEN command->>'commandScope'='application.lifecycle' THEN 'Applicant' ELSE name END,
          'capturedAt',clock_timestamp()) INTO presentation FROM %1$I.users WHERE id=principal;
      END IF;
      IF NOT coalesce(%1$I.audit_human_valid(principal,version,mode,sid),false) THEN PERFORM %1$I.reject_required_audit();END IF;
      RETURN %1$I.create_audit_execution(target,kind,principal,member,NULL,presentation,
        CASE WHEN mode='USER_DELEGATED' THEN 'DOMAIN_WORKER'::%1$I."AuditSource" ELSE 'HTTP'::%1$I."AuditSource" END,command);
    END $fn$;
 $ddl$,s);
END $migration$;

COMMIT;
