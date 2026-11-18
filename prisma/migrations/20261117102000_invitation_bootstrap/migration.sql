BEGIN;
CREATE FUNCTION lookup_workspace_invitation(target_hash text,principal uuid,sid text,expected_auth integer)
RETURNS TABLE(invitation_id uuid,workspace_id uuid,issuer_membership_id uuid,issuer_user_id uuid,ownership_revision integer)
LANGUAGE plpgsql AS $$
DECLARE account users%ROWTYPE; i workspace_invitations%ROWTYPE; issuer_user uuid;
  previous_workspace text:=current_setting('app.workspace_id',true); previous_xid text:=current_setting('app.tenant_xid',true);
BEGIN
  IF current_workspace_id() IS NOT NULL THEN RAISE EXCEPTION 'Invitation bootstrap requires unscoped transaction' USING ERRCODE='42501'; END IF;
  SELECT * INTO account FROM users WHERE id=principal AND status='active' AND auth_version=expected_auth AND email_verified;
  IF NOT FOUND OR NOT EXISTS(SELECT FROM session_auth_grants g JOIN user_sessions s ON s.sid=g.sid
    WHERE g.sid=lookup_workspace_invitation.sid AND g.user_id=principal AND g.auth_version=expected_auth AND s.expire>clock_timestamp()
      AND s.sess->'passport'->'user'->>'id'=principal::text
      AND s.sess::jsonb->'passport'->'user'->'authVersion'=to_jsonb(expected_auth)) THEN RETURN; END IF;
  PERFORM set_config('app.invitation_hash',target_hash,true),set_config('app.invitation_email',account.email,true),set_config('app.invitation_xid',pg_current_xact_id()::text,true);
  SELECT * INTO i FROM workspace_invitations x WHERE x.token_hash=target_hash AND x.email=account.email
    AND (x.status='PENDING' OR (x.status='ACCEPTED' AND x.accepted_user_id=principal));
  IF FOUND THEN
    -- Only a validated token+identity pair may temporarily resolve its one issuer.
    PERFORM set_config('app.workspace_id',i.workspace_id::text,true),set_config('app.tenant_xid',pg_current_xact_id()::text,true);
    SELECT user_id INTO STRICT issuer_user FROM workspace_memberships WHERE id=i.created_by_membership_id AND workspace_memberships.workspace_id=i.workspace_id;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(previous_workspace,''),true),set_config('app.tenant_xid',coalesce(previous_xid,''),true),
    set_config('app.invitation_hash','',true),set_config('app.invitation_email','',true),set_config('app.invitation_xid','',true);
  IF i.id IS NOT NULL THEN RETURN QUERY SELECT i.id,i.workspace_id,i.created_by_membership_id,issuer_user,i.ownership_revision; END IF;
END $$;

CREATE FUNCTION record_invitation_delivery(target_workspace uuid,target uuid,token_generation integer,outcome text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  PERFORM assert_workspace_tenant(target_workspace);
  IF outcome NOT IN('ACCEPTED','FAILED') THEN RAISE EXCEPTION 'Invalid delivery fact'; END IF;
  SELECT ownership_revision INTO STRICT v FROM provider_workspaces WHERE id=target_workspace;
  PERFORM lock_workspace_ownership_revision(target_workspace,v);
  UPDATE workspace_invitations SET delivery_status=outcome WHERE id=target AND workspace_id=target_workspace AND generation=token_generation;
END $$;
DO $$ DECLARE s text:=current_schema(); f text; BEGIN
  FOREACH f IN ARRAY ARRAY['lookup_workspace_invitation(text,uuid,text,integer)','record_invitation_delivery(uuid,uuid,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO renyqo_workspace_runtime',s,f);
  END LOOP;
  EXECUTE format('GRANT SELECT ON %I.user_sessions,%I.session_auth_grants TO renyqo_workspace_invariants',s,s);
END $$;
COMMIT;
