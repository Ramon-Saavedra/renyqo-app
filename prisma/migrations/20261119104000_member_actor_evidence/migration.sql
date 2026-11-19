BEGIN;
-- Domain-specific routing only. Existing IDs/FKs retain their original meaning;
-- in approved assignment evidence the approver, not the assignee, is the actor.
CREATE FUNCTION member_evidence_route(kind text,event jsonb) RETURNS TABLE(workspace uuid,principal uuid,member uuid) LANGUAGE plpgsql AS $$
DECLARE app uuid; listing uuid;
BEGIN
 workspace:=nullif(event->>'workspace_id','')::uuid;
 IF kind='application_activities' AND event->>'actor_type'<>'provider' THEN RETURN; END IF;
 IF kind='listing_events' AND event->>'source'<>'provider' THEN RETURN; END IF;
 IF kind='viewing_command_receipts' AND event->>'actor_side'<>'provider' THEN RETURN; END IF;
 IF kind IN('application_activities','verification_decisions','viewing_command_receipts') THEN
  app:=(event->>'application_id')::uuid;SELECT listing_id INTO listing FROM applications WHERE id=app;
 ELSIF kind IN('listing_events','listing_criteria_revisions') THEN listing:=(event->>'listing_id')::uuid;
 END IF;
 IF listing IS NOT NULL THEN SELECT workspace_id INTO workspace FROM listings WHERE id=listing; END IF;
 IF workspace IS NULL OR current_workspace_id() IS DISTINCT FROM workspace THEN RETURN; END IF;
 IF kind='listing_assignment_transitions' THEN member:=coalesce(event->>'approved_by_membership_id',event->>'initiated_by_membership_id')::uuid;
 ELSIF kind='listing_transfer_requests' THEN member:=(event->>'source_membership_id')::uuid;
 ELSIF kind='workspace_plan_changes' THEN member:=(event->>'actor_membership_id')::uuid;
 ELSE principal:=nullif(event->>'actor_user_id','')::uuid;
 END IF;
 IF member IS NOT NULL THEN SELECT user_id INTO principal FROM workspace_memberships WHERE id=member AND workspace_id=workspace;
 ELSIF principal IS NOT NULL THEN SELECT id INTO member FROM workspace_memberships WHERE user_id=principal AND workspace_id=workspace;
 END IF;
 IF member IS NOT NULL AND principal IS NOT NULL THEN RETURN NEXT; END IF;
END $$;

CREATE FUNCTION capture_member_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;v jsonb;principal uuid;k text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.actor_snapshot IS DISTINCT FROM OLD.actor_snapshot THEN RAISE EXCEPTION 'Actor snapshot is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.actor_snapshot IS NOT NULL THEN
   FOREACH k IN ARRAY ARRAY['id','actor_user_id','workspace_id','application_id','listing_id','actor_membership_id','initiated_by_membership_id','approved_by_membership_id','source_membership_id','actor_type','source','actor_side'] LOOP
    IF to_jsonb(NEW)->k IS DISTINCT FROM to_jsonb(OLD)->k THEN RAISE EXCEPTION 'Historical actor/resource binding is immutable' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
  IF TG_TABLE_NAME='listing_transfer_requests' THEN
   IF OLD.decision_actor_snapshot IS NOT NULL AND NEW.decision_actor_snapshot IS DISTINCT FROM OLD.decision_actor_snapshot THEN RAISE EXCEPTION 'Decision actor snapshot is immutable' USING ERRCODE='23514'; END IF;
   IF OLD.decided_by_membership_id IS NULL AND NEW.decided_by_membership_id IS NOT NULL THEN
    SELECT user_id INTO STRICT principal FROM workspace_memberships WHERE id=NEW.decided_by_membership_id AND workspace_id=NEW.workspace_id;
    NEW.decision_actor_snapshot:=evidence_member_actor_snapshot(NEW.workspace_id,NEW.decided_by_membership_id,principal);
   ELSIF NEW.decision_actor_snapshot IS DISTINCT FROM OLD.decision_actor_snapshot THEN RAISE EXCEPTION 'Decision actor requires a decision' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO r FROM member_evidence_route(TG_TABLE_NAME,to_jsonb(NEW));
 IF r.member IS NOT NULL THEN v:=evidence_member_actor_snapshot(r.workspace,r.member,r.principal);END IF;
 NEW.actor_snapshot:=v;
 IF TG_TABLE_NAME='listing_transfer_requests' THEN NEW.decision_actor_snapshot:=NULL;END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE s text:=current_schema();t text;f text; BEGIN
 EXECUTE format('GRANT SELECT(id,listing_id) ON %I.applications TO renyqo_workspace_invariants',s);
 FOREACH f IN ARRAY ARRAY['member_evidence_route(text,jsonb)','capture_member_evidence()'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
  EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['listing_events','application_activities','verification_decisions','listing_criteria_revisions','viewing_command_receipts','workspace_plan_changes','workspace_invitation_commands','listing_assignment_transitions','listing_transfer_requests'] LOOP
  EXECUTE format('CREATE TRIGGER member_evidence_snapshot BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.capture_member_evidence()',s,t,s);
 END LOOP;
END $$;
COMMIT;
