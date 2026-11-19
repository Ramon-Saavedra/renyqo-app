BEGIN;
CREATE OR REPLACE FUNCTION member_evidence_route(kind text,event jsonb) RETURNS TABLE(workspace uuid,principal uuid,member uuid) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE app uuid; listing uuid;
BEGIN
 workspace:=nullif(event->>'workspace_id','')::uuid;
 IF kind='listing_criteria_revisions' AND event->>'source'<>'NATIVE' THEN RETURN; END IF;
 IF kind='verification_decisions' AND event->>'provenance'<>'NATIVE' THEN RETURN; END IF;
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

DO $$ DECLARE s text:=current_schema();BEGIN
 EXECUTE format('ALTER FUNCTION %I.member_evidence_route(text,jsonb) SET search_path=pg_catalog,%I,pg_temp',s,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.member_evidence_route(text,jsonb) FROM PUBLIC',s);
END $$;
COMMIT;
