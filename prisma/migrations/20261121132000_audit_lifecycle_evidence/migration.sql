BEGIN;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('GRANT SELECT ON %I.application_activities TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT(id,application_id,provider_consideration,revision) ON %I.viewing_workflows TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT(id,listing_id,applicant_id,status) ON %I.applications TO renyqo_workspace_invariants',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_application_evidence(activity uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE a %1$I.application_activities;app %1$I.applications;w uuid;action text;previous text;result text;
 BEGIN
  -- Insert provenance is transaction-bound, including released savepoints.
  SELECT * INTO a FROM %1$I.application_activities WHERE id=activity
   AND EXISTS(SELECT FROM %1$I.audit_activity_sources p WHERE p.activity_id=activity AND p.transaction_id=pg_current_xact_id()::text);
  IF NOT FOUND THEN RETURN NULL;END IF;
  action:=CASE a.type::text WHEN 'application_submitted' THEN 'application.submitted'
   WHEN 'application_withdrawn' THEN 'application.withdrawn' WHEN 'application_rejected' THEN 'application.rejected'
   WHEN 'application_restored' THEN 'application.restored' WHEN 'application_promoted_to_active' THEN 'application.promoted'
   WHEN 'application_accepted' THEN 'application.tenant_selected' WHEN 'viewing_consideration_changed' THEN 'application.consideration_recorded' END;
  IF action IS NULL THEN RETURN NULL;END IF;
  SELECT id,listing_id,applicant_id,status INTO app.id,app.listing_id,app.applicant_id,app.status FROM %1$I.applications WHERE id=a.application_id;
  SELECT workspace_id INTO w FROM %1$I.listing_tenant_routes WHERE listing_id=app.listing_id;
  IF action='application.consideration_recorded' THEN
   IF NOT EXISTS(SELECT FROM %1$I.viewing_workflows v WHERE v.id=(a.payload->>'workflowId')::uuid AND v.application_id=app.id
    AND upper(v.provider_consideration::text)=a.payload->>'providerConsideration' AND v.revision=(a.payload->>'workflowRevision')::integer) THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('action',action,'workspaceId',w,'listingId',app.listing_id,'resourceId',app.id,
    'actorType',upper(a.actor_type::text),'actorUserId',a.actor_user_id,'applicantId',app.applicant_id,'occurredAt',a.occurred_at,
    'changes',jsonb_build_object('decision',a.payload->>'providerConsideration','workflowId',a.payload->>'workflowId','workflowRevision',a.payload->'workflowRevision'));
  END IF;
  previous:=a.payload->>'fromStatus';result:=coalesce(a.payload->>'toStatus',a.payload->>'initialStatus');
  IF upper(app.status::text) IS DISTINCT FROM result OR NOT EXISTS(SELECT FROM %1$I.audit_application_changes x
   WHERE x.application_id=app.id AND x.transaction_id=pg_current_xact_id()::text AND x.previous_status IS NOT DISTINCT FROM previous AND x.new_status=result)
   THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('action',action,'workspaceId',w,'listingId',app.listing_id,'resourceId',app.id,
   'actorType',upper(a.actor_type::text),'actorUserId',a.actor_user_id,'applicantId',app.applicant_id,'occurredAt',a.occurred_at,
   'reason',a.payload->>'reason','changes',jsonb_build_object('previousStatus',previous,'newStatus',result));
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_application_evidence(uuid) FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_application_evidence(uuid) TO renyqo_workspace_invariants',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_application_effect_refs(listings jsonb,profile_scope uuid DEFAULT NULL)
 RETURNS TABLE(id uuid,"applicationId" uuid,"actorType" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE ids uuid[];p %1$I.audit_profile_scopes;w uuid;
 BEGIN
  IF jsonb_typeof(listings) IS DISTINCT FROM 'array' THEN PERFORM %1$I.reject_required_audit();END IF;
  SELECT coalesce(array_agg(v::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements_text(listings) v;
  IF profile_scope IS NOT NULL THEN
   SELECT proof.* INTO p FROM %1$I.audit_profile_scopes proof WHERE proof.id=profile_scope AND proof.transaction_id=pg_current_xact_id()::text;
   IF NOT FOUND OR NOT(ids<@p.listing_ids) OR nullif(current_setting('app.workspace_id',true),'') IS NOT NULL THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSE w:=%1$I.current_workspace_id();IF w IS NULL THEN PERFORM %1$I.reject_required_audit();END IF;END IF;
  RETURN QUERY SELECT a.id,a.application_id,upper(a.actor_type::text) FROM %1$I.audit_activity_sources x
   JOIN %1$I.application_activities a ON a.id=x.activity_id JOIN %1$I.applications app ON app.id=a.application_id
   JOIN %1$I.listing_tenant_routes r ON r.listing_id=app.listing_id
   WHERE x.transaction_id=pg_current_xact_id()::text AND app.listing_id=ANY(ids)
    AND (profile_scope IS NOT NULL OR r.workspace_id=w)
    AND NOT(a.type='viewing_consideration_changed' AND EXISTS(SELECT FROM %1$I.audit_activity_sources other
      JOIN %1$I.application_activities rejection ON rejection.id=other.activity_id
      WHERE other.transaction_id=pg_current_xact_id()::text AND rejection.application_id=a.application_id AND rejection.type='application_rejected')) ORDER BY a.application_id,a.id;
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.audit_application_effect_refs(jsonb,uuid) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_application_effect_refs(jsonb,uuid) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_application_effect_refs(jsonb,uuid) TO renyqo_workspace_runtime',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('GRANT SELECT(workflow_id,interest_state,interest_deadline_at) ON %I.viewing_appointments TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT(id,application_id) ON %I.viewing_workflows TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT SELECT(application_id,listing_id) ON %I.application_eligibility_assessments TO renyqo_workspace_invariants',s);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.open_system_lifecycle_audit(activity uuid,command jsonb,profile_scope uuid DEFAULT NULL) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE e jsonb;purpose text;result uuid:=gen_random_uuid();p %1$I.audit_profile_scopes;w uuid;l uuid;
 BEGIN
  e:=%1$I.audit_application_evidence(activity);
  IF e IS NULL OR e->>'actorType'<>'SYSTEM' OR command->>'commandScope'<>'application.lifecycle.system'
    OR NOT %1$I.audit_command_valid(command) THEN PERFORM %1$I.reject_required_audit();END IF;
  w:=(e->>'workspaceId')::uuid;l:=(e->>'listingId')::uuid;
  IF e->>'action'='application.promoted' AND e->'changes'->>'previousStatus'='WAITING'
    AND e->'changes'->>'newStatus'='ACTIVE' THEN
   purpose:='APPLICATION_QUEUE_RECONCILIATION';
   IF NOT EXISTS(SELECT FROM %1$I.application_eligibility_assessments x WHERE x.application_id=(e->>'resourceId')::uuid
     AND x.listing_id=l)
     THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSIF e->>'action'='application.rejected' AND e->'changes'->>'newStatus'='REJECTED'
    AND e->'changes'->>'previousStatus' IN('ACTIVE','WAITING') AND e->>'reason'='PROFILE_NO_LONGER_ELIGIBLE' THEN purpose:='APPLICATION_ELIGIBILITY_REVALIDATION';
  ELSIF e->>'action'='application.rejected' AND e->'changes'->>'previousStatus'='ACTIVE'
    AND e->'changes'->>'newStatus'='REJECTED' AND e->>'reason'='POST_VIEWING_RESPONSE_EXPIRED' THEN
   purpose:='APPLICATION_VIEWING_INTEREST_EXPIRY';
   IF NOT EXISTS(SELECT FROM %1$I.viewing_appointments a JOIN %1$I.viewing_workflows v ON v.id=a.workflow_id
    WHERE v.application_id=(e->>'resourceId')::uuid AND upper(a.interest_state::text)='EXPIRED'
     AND a.interest_deadline_at<=(e->>'occurredAt')::timestamptz) THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSE PERFORM %1$I.reject_required_audit();END IF;
  IF profile_scope IS NOT NULL THEN
   SELECT * INTO p FROM %1$I.audit_profile_scopes WHERE id=profile_scope AND transaction_id=pg_current_xact_id()::text;
   IF NOT FOUND OR NOT(l=ANY(p.listing_ids)) OR NOT(w=ANY(p.workspace_ids))
    OR nullif(current_setting('app.workspace_id',true),'') IS NOT NULL
    OR (purpose='APPLICATION_ELIGIBILITY_REVALIDATION' AND (e->>'applicantId')::uuid<>p.user_id)
    OR purpose='APPLICATION_VIEWING_INTEREST_EXPIRY' THEN PERFORM %1$I.reject_required_audit();END IF;
  ELSE
   PERFORM %1$I.assert_workspace_tenant(w);
   IF purpose='APPLICATION_ELIGIBILITY_REVALIDATION' THEN PERFORM %1$I.reject_required_audit();END IF;
  END IF;
  -- No caller supplies purpose/actor/workspace; all derive from the exact effect.
  INSERT INTO %1$I.audit_execution_contexts VALUES(result,w,pg_current_xact_id()::text,'SYSTEM',NULL,NULL,purpose,NULL,
   clock_timestamp(),CASE WHEN purpose='APPLICATION_VIEWING_INTEREST_EXPIRY' THEN 'DOMAIN_WORKER'::%1$I."AuditSource" ELSE 'INTERNAL'::%1$I."AuditSource" END,
   (command->>'commandId')::uuid,'application.lifecycle.system',(command->>'correlationId')::uuid,
   activity,ARRAY(SELECT jsonb_array_elements_text(command->'requiredEffects')));
  IF profile_scope IS NOT NULL THEN INSERT INTO %1$I.audit_profile_bindings VALUES(result,profile_scope);END IF;
  RETURN result;
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.open_system_lifecycle_audit(uuid,jsonb,uuid) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.open_system_lifecycle_audit(uuid,jsonb,uuid) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.open_system_lifecycle_audit(uuid,jsonb,uuid) TO renyqo_workspace_runtime',s);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_listing_evidence(c %1$I.audit_execution_contexts,t jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE l %1$I.listings;action text;before_status text:=t->>'previousStatus';changed jsonb:=t->'changedFieldNames';data jsonb;selected uuid;
 BEGIN
  IF c.actor_kind<>'MEMBER' OR c.command_scope<>'provider.lifecycle' OR jsonb_typeof(t) IS DISTINCT FROM 'object'
   OR (t-ARRAY['kind','listingId','previousStatus','revisionBefore','changedFieldNames','ordering','previousPosition'])<>'{}'::jsonb
   OR jsonb_typeof(t->'ordering') IS DISTINCT FROM 'boolean' THEN RETURN NULL;END IF;
  SELECT * INTO l FROM %1$I.listings WHERE id=(t->>'listingId')::uuid AND workspace_id=c.workspace_id;
  IF NOT FOUND OR (c.snapshot->>'actorRoleAtTime'<>'OWNER' AND l.responsible_membership_id<>c.actor_membership_id) THEN RETURN NULL;END IF;
  IF before_status IS NULL THEN
   IF NOT EXISTS(SELECT FROM %1$I.listing_assignment_transitions a WHERE a.listing_id=l.id AND a.workspace_id=c.workspace_id
    AND a.reason='INITIAL' AND a.command_id=c.command_id AND a.initiated_by_membership_id=c.actor_membership_id) THEN RETURN NULL;END IF;
   action:='provider.listing.created';
  ELSIF (t->>'ordering')::boolean THEN
   IF c.snapshot->>'actorRoleAtTime'<>'OWNER' THEN RETURN NULL;END IF;action:='provider.listing.order_changed';
  ELSIF before_status<>upper(l.status::text) THEN
   action:=CASE upper(l.status::text) WHEN 'PUBLISHED' THEN 'provider.listing.published' WHEN 'RETIRED' THEN 'provider.listing.retired'
    WHEN 'RENTED' THEN 'provider.listing.rented' ELSE 'provider.listing.status_changed' END;
  ELSE action:='provider.listing.updated';END IF;
  -- Ordering deliberately leaves the canonical Listing revision unchanged.
  IF action='provider.listing.order_changed' THEN
   IF (t->>'revisionBefore')::integer IS DISTINCT FROM l.revision OR l.display_order IS NULL
     OR (t->>'previousPosition')::integer IS NOT DISTINCT FROM l.display_order THEN RETURN NULL;END IF;
  ELSIF before_status IS NOT NULL AND ((t->>'revisionBefore')::integer IS NULL OR (t->>'revisionBefore')::integer>=l.revision) THEN RETURN NULL;END IF;
  data:=jsonb_build_object('previousStatus',before_status,'newStatus',upper(l.status::text),'changedFieldNames',changed);
  IF action='provider.listing.order_changed' THEN data:=data||jsonb_build_object('previousPosition',t->'previousPosition','newPosition',l.display_order);END IF;
  IF action='provider.listing.rented' THEN
   SELECT app.id INTO STRICT selected FROM %1$I.applications app JOIN %1$I.application_activities a ON a.application_id=app.id
    WHERE app.listing_id=l.id AND app.status='accepted' AND a.type='application_accepted' AND a.actor_user_id=c.actor_user_id
     AND EXISTS(SELECT FROM %1$I.audit_activity_sources x WHERE x.activity_id=a.id AND x.transaction_id=pg_current_xact_id()::text);
   data:=data||jsonb_build_object('selectedApplicationId',selected);
  END IF;
  IF NOT coalesce(%1$I.audit_lifecycle_payload_valid(action,data),false) THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('action',action,'resourceId',l.id,'listingId',l.id,'resourceType','LISTING',
   'occurredAt',clock_timestamp(),'changes',data,'revisionBefore',t->'revisionBefore','revisionAfter',l.revision);
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %1$I.audit_listing_evidence(%1$I.audit_execution_contexts,jsonb) FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.audit_listing_evidence(%1$I.audit_execution_contexts,jsonb) TO renyqo_workspace_invariants',s);
END $migration$;

COMMIT;
