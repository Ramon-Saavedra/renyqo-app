BEGIN;
DO $migration$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.audit_command_valid(command jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
      SELECT coalesce(jsonb_typeof(command)='object' AND NOT EXISTS(
        SELECT FROM jsonb_object_keys(command) k WHERE k<>ALL(ARRAY['commandId','commandScope','correlationId','causationId','requiredEffects']))
        AND command->>'commandScope' IN('audit.ledger.activation','provider.invitation','provider.invitation.accept','provider.plan','provider.assignment','provider.transfer')
        AND jsonb_typeof(command->'requiredEffects')='array'
        AND jsonb_array_length(command->'requiredEffects') BETWEEN 1 AND 32
        AND (SELECT count(*)=count(DISTINCT v) AND bool_and(jsonb_typeof(v)='string' AND (v#>>'{}')~'^[a-z][a-z0-9_.:-]{0,79}$') FROM jsonb_array_elements(command->'requiredEffects') v)
        AND jsonb_typeof(command->'commandId')='string' AND jsonb_typeof(command->'correlationId')='string'
        AND (NOT command ? 'causationId' OR jsonb_typeof(command->'causationId')='string'),false)
    $fn$;
 $ddl$,s);
END $migration$;
COMMIT;
