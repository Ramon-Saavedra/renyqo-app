BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.open_invitation_audit_execution(invitation uuid,principal uuid,version integer,sid text,command jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE w uuid;presentation jsonb;
 BEGIN
  -- Called only after the existing closed admission seam, under its root locks.
  -- No provider bootstrap and no caller-selected workspace or membership.
  SELECT i.workspace_id INTO w FROM %1$I.workspace_invitations i JOIN %1$I.workspace_invitation_commands r
   ON r.workspace_id=i.workspace_id AND r.invitation_id=i.id
   WHERE i.id=invitation AND i.status='ACCEPTED' AND i.accepted_user_id=principal
    AND r.kind='ACCEPT' AND r.actor_user_id=principal AND r.command_id=(command->>'commandId')::uuid;
  IF NOT FOUND OR command->>'commandScope'<>'provider.invitation.accept'
    OR NOT coalesce(%1$I.audit_human_valid(principal,version,'SESSION_BOUND',sid),false)
    THEN PERFORM %1$I.reject_required_audit();END IF;
  PERFORM %1$I.assert_workspace_tenant(w);
  SELECT jsonb_build_object('snapshotVersion',1,'actorDisplayNameAtTime',name,'capturedAt',clock_timestamp()) INTO presentation
   FROM %1$I.users WHERE id=principal;
  RETURN %1$I.create_audit_execution(w,'USER',principal,NULL,NULL,presentation,'HTTP',command);
 END $fn$;
 $ddl$,s);
 EXECUTE format('ALTER FUNCTION %I.open_invitation_audit_execution(uuid,uuid,integer,text,jsonb) OWNER TO renyqo_workspace_invariants',s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.open_invitation_audit_execution(uuid,uuid,integer,text,jsonb) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.open_invitation_audit_execution(uuid,uuid,integer,text,jsonb) TO renyqo_workspace_runtime',s);
END $migration$;
COMMIT;
