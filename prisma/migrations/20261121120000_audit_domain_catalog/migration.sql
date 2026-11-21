BEGIN;
-- Forward-only extension of the deliberately closed Slice 1/2 catalog.
ALTER TABLE audit_events DROP CONSTRAINT audit_event_action_version;
ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_version CHECK(schema_version=1 AND action IN(
 'audit.ledger.activated','provider.invitation.created','provider.invitation.resent','provider.invitation.revoked',
 'provider.invitation.expired','provider.invitation.accepted','provider.membership.created','provider.plan.assigned',
 'provider.listing_assignment.changed','provider.listing_transfer.requested','provider.listing_transfer.decided','provider.listing_transfer.expired'));
ALTER TABLE audit_events DROP CONSTRAINT audit_event_foundation;
ALTER TABLE audit_events ADD CONSTRAINT audit_event_foundation CHECK(
 (action='audit.ledger.activated' AND resource_type='WORKSPACE' AND resource_id=workspace_id
 AND command_scope='audit.ledger.activation' AND effect_key~'^[a-z][a-z0-9_.:-]{0,79}$'
 AND listing_id IS NULL AND resource_revision_before IS NULL AND resource_revision_after IS NULL
 AND revision_kind IS NULL AND source_evidence_type IS NULL AND source_evidence_id IS NULL)
 OR (action<>'audit.ledger.activated' AND actor_kind IN('MEMBER','USER') AND actor_identity_id IS NOT NULL
 AND command_scope IN('provider.invitation','provider.invitation.accept','provider.plan','provider.assignment','provider.transfer')
 AND resource_type IN('INVITATION','MEMBERSHIP','WORKSPACE','LISTING','LISTING_TRANSFER_REQUEST')
 AND source_evidence_type IN('INVITATION_COMMAND','MEMBERSHIP_ADMISSION','PLAN_CHANGE','ASSIGNMENT','TRANSFER_REQUEST')
 AND source_evidence_id IS NOT NULL AND effect_key~'^[a-z][a-z0-9_.:-]{0,79}$'));
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_domain_payload_valid(action text,changes jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE allowed text[]; k text; v jsonb;
 BEGIN
  allowed:=CASE
   WHEN action LIKE 'provider.invitation.%%' THEN ARRAY['statusBefore','statusAfter','revisionBefore','revisionAfter']
   WHEN action='provider.membership.created' THEN ARRAY['statusBefore','statusAfter','role','invitationId']
   WHEN action='provider.plan.assigned' THEN ARRAY['previousPlanVersionId','planVersionId','revision','mode','source']
   WHEN action='provider.listing_assignment.changed' THEN ARRAY['previousMembershipId','newMembershipId','reason']
   WHEN action LIKE 'provider.listing_transfer.%%' THEN ARRAY['statusBefore','statusAfter','sourceMembershipId','targetMembershipId'] END;
  IF allowed IS NULL OR jsonb_typeof(changes)<>'object' OR changes='{}'::jsonb THEN RETURN false;END IF;
  FOR k,v IN SELECT * FROM jsonb_each(changes) LOOP
   IF NOT(k=ANY(allowed)) OR NOT(v='null'::jsonb OR
    (jsonb_typeof(v)='number' AND v::text~'^[0-9]{1,10}$') OR
    (jsonb_typeof(v)='string' AND ((v#>>'{}')~'^[0-9a-fA-F-]{36}$' OR
     (v#>>'{}') IN('PENDING','ACCEPTED','REVOKED','EXPIRED','ACTIVE','AGENT','REQUESTED','APPROVED','REJECTED','CANCELLED',
       'INITIAL','OWNER_REASSIGNMENT','APPROVED_TRANSFER','VOLUNTARY','FORCED','INTERNAL','MOCK_DEV')))) THEN RETURN false;END IF;
  END LOOP;
  RETURN (changes-allowed)='{}'::jsonb AND (SELECT count(*) FROM jsonb_object_keys(changes))=cardinality(allowed);
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_domain_payload_valid(text,jsonb) FROM PUBLIC',s);
 -- CHECK expressions execute with the inserting helper role.
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_domain_payload_valid(text,jsonb) TO renyqo_workspace_invariants',s);
 EXECUTE format('ALTER TABLE %I.audit_events DROP CONSTRAINT audit_event_payload',s);
 EXECUTE format($ddl$ALTER TABLE %1$I.audit_events ADD CONSTRAINT audit_event_payload CHECK(
  octet_length(changes::text)+octet_length(metadata::text)<=8192 AND
  ((action='audit.ledger.activated' AND changes='{}'::jsonb AND metadata='{"activationVersion":1}'::jsonb)
   OR (action<>'audit.ledger.activated' AND metadata='{}'::jsonb AND %1$I.audit_domain_payload_valid(action,changes))))$ddl$,s);
END $migration$;
COMMIT;
