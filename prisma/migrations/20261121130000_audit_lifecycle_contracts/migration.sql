BEGIN;

DO $migration$ DECLARE s text:=current_schema();prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='audit_events'::regclass AND conname='audit_event_action_version';
 ALTER TABLE audit_events DROP CONSTRAINT audit_event_action_version;
 EXECUTE format('ALTER TABLE %I.audit_events ADD CONSTRAINT audit_event_action_version CHECK ((%s) OR (schema_version=1 AND action IN(''provider.listing.created'',''provider.listing.updated'',''provider.listing.published'',''provider.listing.status_changed'',''provider.listing.retired'',''provider.listing.rented'',''provider.listing.order_changed'',''application.submitted'',''application.withdrawn'',''application.rejected'',''application.restored'',''application.promoted'',''application.tenant_selected'',''application.consideration_recorded'')))',s,prior);
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='audit_events'::regclass AND conname='audit_event_foundation';
 ALTER TABLE audit_events DROP CONSTRAINT audit_event_foundation;
 EXECUTE format($ddl$ALTER TABLE %I.audit_events ADD CONSTRAINT audit_event_foundation CHECK((%s) OR (
  command_scope IN('provider.lifecycle','application.lifecycle','application.lifecycle.system') AND actor_identity_id IS NOT NULL
  AND resource_type IN('LISTING','APPLICATION') AND listing_id IS NOT NULL
  AND (action LIKE 'provider.listing.%%' OR action LIKE 'application.%%') AND metadata='{}'::jsonb
  AND effect_key~'^(listing.state|application.activity):[0-9a-f-]{36}$'
  AND ((resource_type='LISTING' AND resource_id=listing_id AND source_evidence_type IS NULL AND source_evidence_id IS NULL)
   OR (resource_type='APPLICATION' AND source_evidence_type='APPLICATION_ACTIVITY' AND source_evidence_id IS NOT NULL))))$ddl$,s,prior);
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='audit_events'::regclass AND conname='audit_event_actor';
 ALTER TABLE audit_events DROP CONSTRAINT audit_event_actor;
 EXECUTE format($ddl$ALTER TABLE %I.audit_events ADD CONSTRAINT audit_event_actor CHECK((%s) OR (
  actor_kind='SYSTEM' AND actor_user_id IS NULL AND actor_membership_id IS NULL
  AND system_purpose IN('APPLICATION_QUEUE_RECONCILIATION','APPLICATION_ELIGIBILITY_REVALIDATION','APPLICATION_VIEWING_INTEREST_EXPIRY')) IS TRUE)$ddl$,s,prior);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.audit_lifecycle_payload_valid(action text,changes jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
 DECLARE fields text[]:=ARRAY['title','street','zip','city','district','country','showExactAddress','objectType','livingArea','rooms','bedrooms','coldRent','additionalCosts','deposit','depositMonths','availableFrom','shortDescription','minimumHouseholdNetIncome','schufaRequired','incomeProofRequired','suitableForPeopleCount','petsPolicy','smokingPolicy'];
 BEGIN
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF action='application.consideration_recorded' THEN
   RETURN changes ?& ARRAY['decision','workflowId','workflowRevision'] AND (changes-ARRAY['decision','workflowId','workflowRevision'])='{}'::jsonb
    AND changes->>'decision' IN('UNDECIDED','CONTINUE_CONSIDERING','DO_NOT_CONTINUE') AND (changes->>'workflowId')~'^[0-9a-f-]{36}$'
    AND (changes->>'workflowRevision')~'^[0-9]{1,10}$';
  END IF;
  IF action LIKE 'application.%%' THEN
   RETURN changes ?& ARRAY['previousStatus','newStatus'] AND (changes-ARRAY['previousStatus','newStatus'])='{}'::jsonb
    AND (changes->'previousStatus'='null'::jsonb OR changes->>'previousStatus' IN('ACTIVE','WAITING','REJECTED','WITHDRAWN','ACCEPTED'))
    AND changes->>'newStatus' IN('ACTIVE','WAITING','REJECTED','WITHDRAWN','ACCEPTED');
  END IF;
  RETURN action LIKE 'provider.listing.%%' AND changes ?& ARRAY['previousStatus','newStatus','changedFieldNames']
   AND (changes-ARRAY['previousStatus','newStatus','changedFieldNames','selectedApplicationId','previousPosition','newPosition'])='{}'::jsonb
   AND (changes->'previousStatus'='null'::jsonb OR changes->>'previousStatus' IN('DRAFT','PUBLISHED','PAUSED','RENTED','RETIRED'))
   AND changes->>'newStatus' IN('DRAFT','PUBLISHED','PAUSED','RENTED','RETIRED')
   AND jsonb_typeof(changes->'changedFieldNames')='array' AND jsonb_array_length(changes->'changedFieldNames')<=cardinality(fields)
   AND NOT EXISTS(SELECT FROM jsonb_array_elements_text(changes->'changedFieldNames') k WHERE NOT(k=ANY(fields)))
   AND (NOT changes ? 'previousPosition' OR changes->'previousPosition'='null'::jsonb OR (changes->>'previousPosition')~'^[0-9]{1,10}$')
   AND (NOT changes ? 'newPosition' OR changes->'newPosition'='null'::jsonb OR (changes->>'newPosition')~'^[0-9]{1,10}$')
   AND (NOT changes ? 'selectedApplicationId' OR (changes->>'selectedApplicationId')~'^[0-9a-f-]{36}$');
 END $fn$;
 $ddl$,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.audit_lifecycle_payload_valid(text,jsonb) FROM PUBLIC',s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.audit_lifecycle_payload_valid(text,jsonb) TO renyqo_workspace_invariants',s);
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='audit_events'::regclass AND conname='audit_event_payload';
 ALTER TABLE audit_events DROP CONSTRAINT audit_event_payload;
 EXECUTE format('ALTER TABLE %1$I.audit_events ADD CONSTRAINT audit_event_payload CHECK((%2$s) OR (metadata=''{}''::jsonb AND octet_length(changes::text)<=8192 AND coalesce(%1$I.audit_lifecycle_payload_valid(action,changes),false)))',s,prior);
END $migration$;

DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.audit_command_valid(command jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
      SELECT coalesce(jsonb_typeof(command)='object' AND NOT EXISTS(
        SELECT FROM jsonb_object_keys(command) k WHERE k<>ALL(ARRAY['commandId','commandScope','correlationId','causationId','requiredEffects']))
        AND command->>'commandScope' IN('audit.ledger.activation','provider.invitation','provider.invitation.accept','provider.plan','provider.assignment','provider.transfer','provider.lifecycle','application.lifecycle','application.lifecycle.system')
        AND jsonb_typeof(command->'requiredEffects')='array'
        AND jsonb_array_length(command->'requiredEffects') BETWEEN 1 AND 32
        AND (SELECT count(*)=count(DISTINCT v) AND bool_and(jsonb_typeof(v)='string' AND (v#>>'{}')~'^[a-z][a-z0-9_.:-]{0,79}$') FROM jsonb_array_elements(command->'requiredEffects') v)
        AND jsonb_typeof(command->'commandId')='string' AND jsonb_typeof(command->'correlationId')='string'
        AND (NOT command ? 'causationId' OR jsonb_typeof(command->'causationId')='string'),false)
    $fn$;
 $ddl$,s);
END $migration$;

COMMIT;
