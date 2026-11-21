BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_invitation_evidence(c %1$I.audit_execution_contexts,kind text,evidence uuid) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE i %1$I.workspace_invitations; r %1$I.workspace_invitation_commands; suffix text;
 BEGIN
  SELECT * INTO r FROM %1$I.workspace_invitation_commands WHERE workspace_id=c.workspace_id AND command_id=evidence
    AND command_id=c.command_id AND actor_user_id=c.actor_user_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT * INTO i FROM %1$I.workspace_invitations WHERE id=r.invitation_id AND workspace_id=c.workspace_id;
  IF NOT FOUND OR i.revision<>r.result_revision THEN RETURN NULL;END IF;
  IF kind='MEMBERSHIP_ADMISSION' THEN
   IF c.command_scope<>'provider.invitation.accept' OR c.actor_kind<>'USER' OR r.kind<>'ACCEPT'
     OR i.accepted_user_id<>c.actor_user_id OR i.acceptance_kind IS DISTINCT FROM 'CREATED' THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('action','provider.membership.created','occurredAt',r.occurred_at,'resourceType','MEMBERSHIP','resourceId',i.accepted_membership_id,
    'changes',jsonb_build_object('statusBefore',NULL,'statusAfter','ACTIVE','role','AGENT','invitationId',i.id));
  END IF;
  IF r.kind='ACCEPT' THEN
   IF c.command_scope<>'provider.invitation.accept' OR c.actor_kind<>'USER' OR i.accepted_user_id<>c.actor_user_id THEN RETURN NULL;END IF;
   suffix:='accepted';
  ELSE
   IF c.command_scope<>'provider.invitation' OR c.actor_kind<>'MEMBER' THEN RETURN NULL;END IF;
   suffix:=CASE r.kind WHEN 'CREATE' THEN 'created' WHEN 'RESEND' THEN 'resent'
      WHEN 'EXPIRE' THEN 'expired' WHEN 'REVOKE' THEN CASE i.status WHEN 'EXPIRED' THEN 'expired' ELSE 'revoked' END END;
  END IF;
  IF suffix IS NULL THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('action','provider.invitation.'||suffix,'occurredAt',r.occurred_at,'resourceType','INVITATION','resourceId',i.id,
   'changes',jsonb_build_object('statusBefore',CASE WHEN r.kind='CREATE' THEN NULL ELSE 'PENDING' END,
    'statusAfter',i.status,'revisionBefore',CASE WHEN r.kind='CREATE' THEN NULL ELSE r.result_revision-1 END,'revisionAfter',r.result_revision));
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_invitation_evidence(%I.audit_execution_contexts,text,uuid) FROM PUBLIC,renyqo_workspace_runtime',s,s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_invitation_evidence(%I.audit_execution_contexts,text,uuid) TO renyqo_workspace_invariants',s,s);
END $migration$;
COMMIT;
