BEGIN;
CREATE FUNCTION convert_workspace_plan_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    -- Conversion grants no organization plan. Preserve both assignment histories.
    UPDATE workspace_plan_assignments SET plan_version_id=NULL,source='INTERNAL',change_mode='FORCED',
      command_id=gen_random_uuid(),actor_membership_id=(SELECT id FROM workspace_memberships WHERE workspace_id=NEW.id AND role='OWNER')
    WHERE workspace_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_plan_conversion AFTER UPDATE OF kind ON provider_workspaces FOR EACH ROW EXECUTE FUNCTION convert_workspace_plan_assignment();
DO $$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.convert_workspace_plan_assignment() SECURITY DEFINER',s);
  EXECUTE format('ALTER FUNCTION %I.convert_workspace_plan_assignment() SET search_path=pg_catalog,%I,pg_temp',s,s);
  EXECUTE format('ALTER FUNCTION %I.convert_workspace_plan_assignment() OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.convert_workspace_plan_assignment() FROM PUBLIC',s);
END $$;
COMMIT;
