BEGIN;
CREATE FUNCTION build_member_actor_snapshot(target uuid,member uuid,principal uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 PERFORM assert_workspace_tenant(target);
 SELECT jsonb_build_object('snapshotVersion',1,'actorUserId',u.id,'actorMembershipId',m.id,
  'actorWorkspaceId',m.workspace_id,'actorRoleAtTime',m.role,'actorDisplayNameAtTime',u.name,
  'actorColorAtTime',m.display_color,'capturedAt',clock_timestamp()) INTO result
 FROM workspace_memberships m JOIN users u ON u.id=m.user_id
 WHERE m.workspace_id=target AND m.id=member AND u.id=principal;
 IF result IS NULL THEN RAISE EXCEPTION 'Actor does not belong to evidence workspace' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;

CREATE FUNCTION evidence_member_actor_snapshot(target uuid,member uuid,principal uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE stamp jsonb; canonical jsonb; original_owner uuid; has_baseline boolean;
BEGIN
 canonical:=build_member_actor_snapshot(target,member,principal);
 IF current_setting('app.member_actor_xid',true)=pg_current_xact_id()::text THEN
  stamp:=nullif(current_setting('app.member_actor_snapshot',true),'')::jsonb;
  IF stamp->>'actorWorkspaceId'=target::text AND stamp->>'actorMembershipId'=member::text AND stamp->>'actorUserId'=principal::text THEN
   -- Only the role can differ after a role-changing mutation. Display facts
   -- were read under the pre-existing sorted User SHARE fence before mutation.
   IF (stamp-'actorRoleAtTime'-'capturedAt') IS DISTINCT FROM (canonical-'actorRoleAtTime'-'capturedAt')
     OR NOT coalesce(stamp->>'actorRoleAtTime' IN('OWNER','AGENT'),false)
     OR stamp->>'capturedAt' IS NULL
     OR (stamp->>'capturedAt')::timestamptz<transaction_timestamp()
     OR (stamp->>'capturedAt')::timestamptz>clock_timestamp() THEN
    RAISE EXCEPTION 'Invalid transaction actor presentation' USING ERRCODE='23514';
   END IF;
   IF stamp->>'actorRoleAtTime'<>canonical->>'actorRoleAtTime' THEN
    SELECT baseline_membership_id INTO original_owner FROM workspace_ownership_revision_baselines WHERE workspace_id=target AND transaction_id=pg_current_xact_id()::text;
    has_baseline:=FOUND;
    IF NOT has_baseline OR NOT ((stamp->>'actorRoleAtTime'='OWNER' AND original_owner=member) OR
      (stamp->>'actorRoleAtTime'='AGENT' AND canonical->>'actorRoleAtTime'='OWNER' AND original_owner IS DISTINCT FROM member)) THEN
     RAISE EXCEPTION 'Role snapshot lacks transaction provenance' USING ERRCODE='23514';
    END IF;
   END IF;
   RETURN stamp;
  END IF;
 END IF;
 RETURN canonical;
END $$;

DO $$ DECLARE s text:=current_schema();t text;f text; BEGIN
 FOREACH t IN ARRAY ARRAY['listing_events','application_activities','verification_decisions','listing_criteria_revisions','viewing_command_receipts','workspace_plan_changes','workspace_invitation_commands','listing_assignment_transitions','listing_transfer_requests'] LOOP
  EXECUTE format('ALTER TABLE %I.%I ADD COLUMN actor_snapshot jsonb',s,t);
 END LOOP;
 EXECUTE format('ALTER TABLE %I.listing_transfer_requests ADD COLUMN decision_actor_snapshot jsonb',s);
 FOREACH f IN ARRAY ARRAY['build_member_actor_snapshot(uuid,uuid,uuid)','evidence_member_actor_snapshot(uuid,uuid,uuid)'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
 END LOOP;
 -- Invoker access: this cannot expose rows beyond the selected tenant/RLS.
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.build_member_actor_snapshot(uuid,uuid,uuid) TO renyqo_workspace_runtime,renyqo_workspace_invariants',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.evidence_member_actor_snapshot(uuid,uuid,uuid) TO renyqo_workspace_invariants',s);
END $$;
COMMIT;
