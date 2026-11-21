BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_portfolio_evidence(c %1$I.audit_execution_contexts,kind text,evidence uuid) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE p %1$I.workspace_plan_changes; a %1$I.listing_assignment_transitions; r %1$I.listing_transfer_requests; action text;
 BEGIN
  IF kind='PLAN_CHANGE' AND c.command_scope='provider.plan' THEN
   SELECT * INTO p FROM %1$I.workspace_plan_changes WHERE id=evidence AND workspace_id=c.workspace_id
    AND command_id=c.command_id AND actor_membership_id=c.actor_membership_id;
   IF NOT FOUND THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('action','provider.plan.assigned','occurredAt',p.occurred_at,'resourceType','WORKSPACE','resourceId',c.workspace_id,
    'changes',jsonb_build_object('previousPlanVersionId',p.previous_plan_version_id,'planVersionId',p.plan_version_id,
      'revision',p.revision,'mode',p.change_mode,'source',p.source));
  ELSIF kind='ASSIGNMENT' AND c.command_scope='provider.assignment' THEN
   SELECT * INTO a FROM %1$I.listing_assignment_transitions WHERE id=evidence AND workspace_id=c.workspace_id
    AND command_id=c.command_id AND coalesce(approved_by_membership_id,initiated_by_membership_id)=c.actor_membership_id;
   IF NOT FOUND THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('action','provider.listing_assignment.changed','occurredAt',a.occurred_at,'resourceType','LISTING','resourceId',a.listing_id,'listingId',a.listing_id,
    'changes',jsonb_build_object('previousMembershipId',a.previous_membership_id,'newMembershipId',a.new_membership_id,'reason',a.reason));
  ELSIF kind='TRANSFER_REQUEST' AND c.command_scope='provider.transfer' THEN
   SELECT * INTO r FROM %1$I.listing_transfer_requests WHERE id=evidence AND workspace_id=c.workspace_id AND command_id=c.command_id;
   IF NOT FOUND OR (r.status IN('REQUESTED','EXPIRED') AND r.source_membership_id<>c.actor_membership_id)
     OR (r.status NOT IN('REQUESTED','EXPIRED') AND r.decided_by_membership_id IS DISTINCT FROM c.actor_membership_id) THEN RETURN NULL;END IF;
   action:=CASE r.status WHEN 'REQUESTED' THEN 'requested' WHEN 'EXPIRED' THEN 'expired' ELSE 'decided' END;
   RETURN jsonb_build_object('action','provider.listing_transfer.'||action,'occurredAt',coalesce(r.decided_at,r.created_at),'resourceType','LISTING_TRANSFER_REQUEST','resourceId',r.id,'listingId',r.listing_id,
    'changes',jsonb_build_object('statusBefore',CASE WHEN r.status='REQUESTED' THEN NULL ELSE 'REQUESTED' END,'statusAfter',r.status,
      'sourceMembershipId',r.source_membership_id,'targetMembershipId',r.target_membership_id));
  END IF;
  RETURN NULL;
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_portfolio_evidence(%I.audit_execution_contexts,text,uuid) FROM PUBLIC,renyqo_workspace_runtime',s,s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_portfolio_evidence(%I.audit_execution_contexts,text,uuid) TO renyqo_workspace_invariants',s,s);
END $migration$;
COMMIT;
