BEGIN;
CREATE OR REPLACE FUNCTION admit_workspace_invitation(target uuid,principal uuid,target_hash text,command uuid,prospective_member uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i workspace_invitations%ROWTYPE; owner workspace_memberships%ROWTYPE; member workspace_memberships%ROWTYPE;
  account users%ROWTYPE; issuer users%ROWTYPE; w provider_workspaces%ROWTYPE; r workspace_seat_reservations%ROWTYPE; usage record;
BEGIN
  SELECT * INTO STRICT i FROM workspace_invitations WHERE id=target;
  PERFORM assert_capacity_transaction(i.workspace_id);
  SELECT * INTO STRICT account FROM users WHERE id=principal;
  IF account.status<>'active' OR NOT account.email_verified OR account.email<>i.email OR i.token_hash<>target_hash THEN
    RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
  SELECT * INTO member FROM workspace_memberships WHERE workspace_id=i.workspace_id AND user_id=principal;
  SELECT * INTO STRICT w FROM provider_workspaces WHERE id=i.workspace_id;
  IF w.lifecycle_status<>'ACTIVE' THEN RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
  IF EXISTS(SELECT FROM workspace_invitation_commands WHERE workspace_id=i.workspace_id AND command_id=command
    AND (kind<>'ACCEPT' OR actor_user_id<>principal OR invitation_id<>target)) THEN
    RAISE EXCEPTION 'INVITATION_COMMAND_CONFLICT' USING ERRCODE='23514',CONSTRAINT='INVITATION_COMMAND_CONFLICT'; END IF;
  IF i.status='ACCEPTED' THEN
    IF i.accepted_user_id<>principal OR member.id IS DISTINCT FROM i.accepted_membership_id OR member.status<>'ACTIVE' THEN
      RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
    INSERT INTO workspace_invitation_commands(workspace_id,command_id,invitation_id,kind,actor_user_id,input_hash,result_revision)
      VALUES(i.workspace_id,command,i.id,'ACCEPT',principal,encode(sha256(convert_to('ACCEPT:'||target::text||':'||principal::text,'UTF8')),'hex'),i.revision)
      ON CONFLICT(workspace_id,command_id) DO NOTHING;
    RETURN member.id;
  END IF;
  SELECT * INTO STRICT owner FROM workspace_memberships WHERE id=i.created_by_membership_id AND workspace_id=i.workspace_id;
  SELECT * INTO STRICT issuer FROM users WHERE id=owner.user_id;
  IF i.status<>'PENDING' OR clock_timestamp()>=i.expires_at OR w.kind<>'ORGANIZATION' OR w.lifecycle_status<>'ACTIVE'
    OR owner.role<>'OWNER' OR owner.status<>'ACTIVE' OR owner.revision<>i.issuer_membership_revision
    OR issuer.status<>'active' OR issuer.auth_version<>i.issuer_auth_version OR w.ownership_revision<>i.ownership_revision THEN
    RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
  IF member.id IS NOT NULL AND member.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'MEMBERSHIP_LIFECYCLE_CONFLICT' USING ERRCODE='23514',CONSTRAINT='MEMBERSHIP_LIFECYCLE_CONFLICT'; END IF;
  SELECT * INTO STRICT r FROM workspace_seat_reservations WHERE id=i.reservation_id AND workspace_id=i.workspace_id FOR UPDATE;
  SELECT * INTO i FROM workspace_invitations WHERE id=target FOR UPDATE;
  IF r.released_at IS NOT NULL OR r.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'INVITATION_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='INVITATION_UNAVAILABLE'; END IF;
  IF member.id IS NULL THEN
    SELECT * INTO STRICT usage FROM workspace_capacity(i.workspace_id);
    IF usage.max_seats=0 THEN RAISE EXCEPTION 'PLAN_UNAVAILABLE' USING ERRCODE='23514',CONSTRAINT='PLAN_UNAVAILABLE'; END IF;
    IF usage.members_used+usage.reservations_used>usage.max_seats OR usage.listings_used>usage.max_listings THEN
      RAISE EXCEPTION 'WORKSPACE_OVER_LIMIT' USING ERRCODE='23514',CONSTRAINT='WORKSPACE_OVER_LIMIT'; END IF;
  END IF;
  UPDATE workspace_seat_reservations SET released_at=clock_timestamp() WHERE id=r.id;
  IF member.id IS NULL THEN
    INSERT INTO workspace_memberships(id,workspace_id,user_id,role,status,display_color,created_at)
      VALUES(prospective_member,i.workspace_id,principal,'AGENT','ACTIVE',i.requested_color_id,clock_timestamp()) RETURNING * INTO member;
    UPDATE workspace_invitations SET status='ACCEPTED',accepted_membership_id=member.id,accepted_user_id=principal,acceptance_kind='CREATED' WHERE id=i.id;
  ELSE
    UPDATE workspace_invitations SET status='ACCEPTED',accepted_membership_id=member.id,accepted_user_id=principal,acceptance_kind='ALREADY_MEMBER' WHERE id=i.id;
  END IF;
  INSERT INTO workspace_invitation_commands(workspace_id,command_id,invitation_id,kind,actor_user_id,input_hash,result_revision)
    VALUES(i.workspace_id,command,i.id,'ACCEPT',principal,encode(sha256(convert_to('ACCEPT:'||target::text||':'||principal::text,'UTF8')),'hex'),i.revision+1);
  RETURN member.id;
END $$;

DO $$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.admit_workspace_invitation(uuid,uuid,text,uuid,uuid) SET search_path=pg_catalog,%I,pg_temp',s,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.admit_workspace_invitation(uuid,uuid,text,uuid,uuid) FROM PUBLIC',s);
END $$;
COMMIT;
