BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.append_domain_audit_event(context uuid,effect text,kind text,evidence uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE c %1$I.audit_execution_contexts; e jsonb;result uuid:=gen_random_uuid();expected text;
 BEGIN
  SELECT * INTO c FROM %1$I.audit_execution_contexts WHERE id=context AND transaction_id=pg_current_xact_id()::text;
  IF NOT FOUND OR c.actor_kind NOT IN('MEMBER','USER') OR NOT(effect=ANY(c.required_effects)) THEN PERFORM %1$I.reject_required_audit();END IF;
  PERFORM %1$I.assert_workspace_tenant(c.workspace_id);
  e:=CASE WHEN kind IN('INVITATION_COMMAND','MEMBERSHIP_ADMISSION') THEN %1$I.audit_invitation_evidence(c,kind,evidence)
    ELSE %1$I.audit_portfolio_evidence(c,kind,evidence) END;
  expected:=replace(e->>'action','provider.','')||':'||(e->>'resourceId');
  IF e IS NULL OR effect IS DISTINCT FROM expected THEN PERFORM %1$I.reject_required_audit();END IF;
  INSERT INTO %1$I.audit_actor_identities VALUES(c.id,c.workspace_id,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.snapshot,c.captured_at) ON CONFLICT(id) DO NOTHING;
  IF NOT EXISTS(SELECT FROM %1$I.audit_actor_identities i WHERE i.id=c.id AND
    (i.workspace_id,i.actor_kind,i.actor_user_id,i.actor_membership_id,i.snapshot,i.captured_at) IS NOT DISTINCT FROM
    (c.workspace_id,c.actor_kind,c.actor_user_id,c.actor_membership_id,c.snapshot,c.captured_at)) THEN PERFORM %1$I.reject_required_audit();END IF;
  INSERT INTO %1$I.audit_events(id,workspace_id,action,schema_version,actor_kind,actor_user_id,actor_membership_id,
   resource_type,resource_id,listing_id,occurred_at,source,correlation_id,causation_id,command_id,command_scope,effect_key,
   source_evidence_type,source_evidence_id,changes,metadata,actor_identity_id)
  VALUES(result,c.workspace_id,e->>'action',1,c.actor_kind,c.actor_user_id,c.actor_membership_id,
   e->>'resourceType',(e->>'resourceId')::uuid,(e->>'listingId')::uuid,(e->>'occurredAt')::timestamptz,c.source,c.correlation_id,c.causation_id,
   c.command_id,c.command_scope,effect,kind,evidence,e->'changes','{}',c.id);
  RETURN result;
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.append_domain_audit_event(uuid,text,text,uuid) FROM PUBLIC,renyqo_workspace_runtime',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.append_domain_audit_event(uuid,text,text,uuid) TO renyqo_workspace_invariants',s);
 EXECUTE format('ALTER FUNCTION %I.append_domain_audit_event(uuid,text,text,uuid) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.append_domain_audit_event(uuid,text,text,uuid) TO renyqo_workspace_runtime',s);
END $migration$;
COMMIT;
