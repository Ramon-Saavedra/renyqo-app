CREATE TYPE "WorkspaceMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');
ALTER TABLE workspace_memberships
  ADD COLUMN status "WorkspaceMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT removed_membership_not_owner CHECK (status <> 'REMOVED' OR role <> 'OWNER'),
  ADD CONSTRAINT workspace_memberships_id_workspace_id_key UNIQUE (id, workspace_id);

-- Preserve the original identity baseline; do not infer suspension from User.
-- Follow the existing parent-first protocol even for this additive backfill.
DO $$ DECLARE w record; BEGIN
  FOR w IN SELECT id, ownership_revision FROM provider_workspaces ORDER BY id LOOP
    PERFORM lock_workspace_ownership_revision(w.id, w.ownership_revision);
    UPDATE workspace_memberships SET updated_at = created_at WHERE workspace_id = w.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION guard_workspace_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'Membership establishes ACTIVE at revision one' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.display_color IS DISTINCT FROM OLD.display_color OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Membership identity and color are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Membership revision is database-derived' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status = 'SUSPENDED' THEN
    RAISE EXCEPTION 'Removed membership cannot be suspended' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status = 'ACTIVE' AND NEW.role <> 'AGENT' THEN
    RAISE EXCEPTION 'Reinstatement restores AGENT, never historical ownership' USING ERRCODE = '23514';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_establishment_guard BEFORE INSERT ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_workspace_membership_identity();

CREATE OR REPLACE FUNCTION check_workspace_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; w provider_workspaces%ROWTYPE; owner_user uuid;
BEGIN
  IF TG_TABLE_NAME = 'provider_workspaces' THEN target := NEW.id; ELSE target := NEW.workspace_id; END IF;
  SELECT * INTO w FROM provider_workspaces WHERE id = target;
  IF NOT FOUND THEN RAISE EXCEPTION 'Established workspace is missing' USING ERRCODE = '23514'; END IF;
  IF (SELECT count(*) FROM workspace_memberships WHERE workspace_id = target AND role = 'OWNER') <> 1 THEN
    RAISE EXCEPTION 'Established workspace requires exactly one OWNER' USING ERRCODE = '23514';
  END IF;
  IF (w.kind = 'ORGANIZATION') IS DISTINCT FROM EXISTS (SELECT 1 FROM organization_profiles WHERE workspace_id = target) THEN
    RAISE EXCEPTION 'Organization profile must match workspace kind' USING ERRCODE = '23514';
  END IF;
  IF w.kind = 'PERSONAL' THEN
    IF (SELECT count(*) FROM workspace_memberships WHERE workspace_id = target AND status <> 'REMOVED') <> 1 THEN
      RAISE EXCEPTION 'PERSONAL requires exactly one non-REMOVED membership' USING ERRCODE = '23514';
    END IF;
    SELECT user_id INTO owner_user FROM workspace_memberships WHERE workspace_id = target AND role = 'OWNER';
    IF NOT EXISTS (SELECT 1 FROM personal_workspace_allocations WHERE workspace_id = target AND user_id = owner_user) THEN
      RAISE EXCEPTION 'PERSONAL requires owner allocation evidence' USING ERRCODE = '23514';
    END IF;
    IF w.lifecycle_status <> 'CLOSED' AND NOT EXISTS (
      SELECT 1 FROM personal_workspace_allocations WHERE workspace_id = target AND user_id = owner_user AND released_at IS NULL
    ) THEN RAISE EXCEPTION 'PERSONAL owner requires an open allocation' USING ERRCODE = '23514'; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM personal_workspace_allocations a WHERE a.workspace_id = target AND (
      (w.lifecycle_status = 'CLOSED' AND (a.released_at IS DISTINCT FROM w.closed_at OR a.release_reason IS DISTINCT FROM 'WORKSPACE_CLOSED'::"PersonalAllocationReleaseReason")) OR
      (w.lifecycle_status <> 'CLOSED' AND a.released_at IS NOT NULL)
    )
  ) THEN RAISE EXCEPTION 'Allocation release contradicts workspace closure' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
