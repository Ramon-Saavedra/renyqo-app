BEGIN;
-- Close the backfill/initialization race using the existing workspace root.
LOCK TABLE provider_workspaces IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Entitlement backfill requires the separate migration/admin credential with full RLS visibility';
  END IF;
  IF EXISTS(SELECT FROM listings l JOIN provider_workspaces w ON w.id=l.workspace_id
    WHERE w.kind='PERSONAL' AND l.status<>'retired' GROUP BY w.id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Resolve PERSONAL listing excess before entitlement cutover';
  END IF;
END $$;

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY,
  plan_key varchar(80) NOT NULL,
  version integer NOT NULL CHECK(version>0),
  workspace_kind "WorkspaceKind" NOT NULL,
  max_listings integer NOT NULL CHECK(max_listings>0),
  max_seats integer NOT NULL CHECK(max_seats>0),
  features text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK(cardinality(features)=0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(plan_key,version)
);
-- No commercial organization limits/features have been approved.
INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats)
VALUES('45700000-0000-4000-8000-000000000001','PERSONAL_FREE',1,'PERSONAL',1,1);

CREATE TABLE workspace_plan_assignments (
  workspace_id uuid PRIMARY KEY REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  plan_version_id uuid REFERENCES plan_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  source varchar(24) NOT NULL CHECK(source IN('BASELINE','INTERNAL','MOCK_DEV')),
  change_mode varchar(16) NOT NULL DEFAULT 'VOLUNTARY' CHECK(change_mode IN('VOLUNTARY','FORCED')),
  command_id uuid NOT NULL,
  actor_membership_id uuid,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(actor_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE workspace_plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  revision integer NOT NULL,
  previous_plan_version_id uuid REFERENCES plan_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  plan_version_id uuid REFERENCES plan_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source varchar(24) NOT NULL,
  change_mode varchar(16) NOT NULL,
  command_id uuid NOT NULL,
  actor_membership_id uuid,
  occurred_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,revision), UNIQUE(workspace_id,command_id),
  FOREIGN KEY(actor_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE workspace_seat_reservations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  command_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL CHECK(isfinite(expires_at)),
  released_at timestamptz(3),
  CHECK(expires_at>created_at), CHECK(released_at IS NULL OR released_at>=created_at),
  UNIQUE(workspace_id,command_id)
);
CREATE INDEX workspace_seat_reservations_occupancy ON workspace_seat_reservations(workspace_id,expires_at) WHERE released_at IS NULL;

INSERT INTO workspace_plan_assignments(workspace_id,plan_version_id,source,command_id)
SELECT id,CASE WHEN kind='PERSONAL' THEN '45700000-0000-4000-8000-000000000001'::uuid END,'BASELINE',gen_random_uuid()
FROM provider_workspaces;
INSERT INTO workspace_plan_changes(workspace_id,revision,plan_version_id,source,change_mode,command_id)
SELECT workspace_id,revision,plan_version_id,source,change_mode,command_id FROM workspace_plan_assignments;

DO $$ DECLARE s text:=current_schema(); t text; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_versions','workspace_plan_assignments','workspace_plan_changes','workspace_seat_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner',s,t);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,renyqo_workspace_runtime',s,t);
    EXECUTE format('GRANT SELECT ON %I.%I TO renyqo_workspace_runtime',s,t);
    EXECUTE format('GRANT SELECT ON %I.%I TO renyqo_workspace_invariants',s,t);
    IF t<>'plan_versions' THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
      EXECUTE format('CREATE POLICY entitlement_tenant ON %I.%I TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,t,s,s);
      EXECUTE format('CREATE POLICY entitlement_fence ON %I.%I AS RESTRICTIVE TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,t,s,s);
    END IF;
  END LOOP;
  EXECUTE format('GRANT INSERT,UPDATE ON %I.workspace_plan_assignments,%I.workspace_seat_reservations TO renyqo_workspace_runtime',s,s);
  EXECUTE format('GRANT INSERT,UPDATE ON %I.workspace_plan_assignments TO renyqo_workspace_invariants',s);
  EXECUTE format('GRANT INSERT ON %I.workspace_plan_changes TO renyqo_workspace_invariants',s);
END $$;
CREATE FUNCTION record_workspace_plan_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_plan_changes(workspace_id,revision,previous_plan_version_id,plan_version_id,source,change_mode,command_id,actor_membership_id)
  VALUES(NEW.workspace_id,NEW.revision,CASE WHEN TG_OP='UPDATE' THEN OLD.plan_version_id END,NEW.plan_version_id,NEW.source,NEW.change_mode,NEW.command_id,NEW.actor_membership_id);
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_plan_change AFTER INSERT OR UPDATE ON workspace_plan_assignments FOR EACH ROW EXECUTE FUNCTION record_workspace_plan_change();

CREATE FUNCTION initialize_workspace_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_plan_assignments(workspace_id,plan_version_id,source,command_id)
  VALUES(NEW.id,CASE WHEN NEW.kind='PERSONAL' THEN '45700000-0000-4000-8000-000000000001'::uuid END,'BASELINE',gen_random_uuid());
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_plan_initial AFTER INSERT ON provider_workspaces FOR EACH ROW EXECUTE FUNCTION initialize_workspace_plan();

DO $$ DECLARE s text:=current_schema(); f text; BEGIN
  FOREACH f IN ARRAY ARRAY['record_workspace_plan_change()','initialize_workspace_plan()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
  END LOOP;
END $$;
COMMIT;
