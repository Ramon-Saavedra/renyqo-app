CREATE TYPE "WorkspaceKind" AS ENUM ('PERSONAL', 'ORGANIZATION');
CREATE TYPE "WorkspaceLifecycle" AS ENUM ('ACTIVE', 'CLOSING', 'CLOSED');
CREATE TYPE "WorkspaceMembershipRole" AS ENUM ('OWNER', 'AGENT');
CREATE TYPE "PersonalAllocationReleaseReason" AS ENUM ('WORKSPACE_CLOSED');

CREATE TABLE provider_workspaces (
  id uuid PRIMARY KEY,
  kind "WorkspaceKind" NOT NULL,
  display_name varchar(160) NOT NULL CHECK (length(btrim(display_name)) > 0),
  lifecycle_status "WorkspaceLifecycle" NOT NULL DEFAULT 'ACTIVE',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ownership_revision integer NOT NULL DEFAULT 1 CHECK (ownership_revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closing_at timestamptz(3),
  closed_at timestamptz(3),
  CONSTRAINT workspace_closure_times CHECK (
    (lifecycle_status = 'ACTIVE' AND closing_at IS NULL AND closed_at IS NULL) OR
    (lifecycle_status = 'CLOSING' AND closing_at IS NOT NULL AND closed_at IS NULL) OR
    (lifecycle_status = 'CLOSED' AND closing_at IS NOT NULL AND closed_at IS NOT NULL AND closed_at >= closing_at)
  ),
  CONSTRAINT workspace_closure_after_creation CHECK (closing_at IS NULL OR closing_at >= created_at)
);

CREATE TABLE workspace_memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  role "WorkspaceMembershipRole" NOT NULL,
  display_color varchar(7) NOT NULL CHECK (display_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT workspace_memberships_workspace_id_user_id_key UNIQUE (workspace_id, user_id)
);
CREATE UNIQUE INDEX workspace_one_owner ON workspace_memberships(workspace_id) WHERE role = 'OWNER';
CREATE INDEX workspace_memberships_user_id_workspace_id_idx ON workspace_memberships(user_id, workspace_id);

CREATE TABLE organization_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  legal_name varchar(240) CHECK (legal_name IS NULL OR length(btrim(legal_name)) > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE personal_workspace_allocations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  allocated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at timestamptz(3),
  release_reason "PersonalAllocationReleaseReason",
  CONSTRAINT allocation_release_fields CHECK (
    (released_at IS NULL AND release_reason IS NULL) OR
    (released_at IS NOT NULL AND released_at >= allocated_at AND release_reason IS NOT NULL AND release_reason = 'WORKSPACE_CLOSED')
  )
);
CREATE UNIQUE INDEX personal_allocation_one_open_per_user ON personal_workspace_allocations(user_id) WHERE released_at IS NULL;
CREATE INDEX personal_workspace_allocations_workspace_id_idx ON personal_workspace_allocations(workspace_id);
CREATE INDEX personal_workspace_allocations_user_id_allocated_at_id_idx ON personal_workspace_allocations(user_id, allocated_at, id);

-- A parent-row write (not just a row lock) also invalidates stale RR/Serializable
-- snapshots. Every structural child mutation participates in this protocol.
CREATE FUNCTION lock_workspace_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workspace structural history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  UPDATE provider_workspaces SET revision = revision WHERE id = NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace is missing' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_provider_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workspace closure is not deletion' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_status <> 'ACTIVE' OR NEW.revision <> 1 OR NEW.ownership_revision <> 1 THEN
      RAISE EXCEPTION 'Workspace must be established ACTIVE at revision one' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Workspace identity is immutable' USING ERRCODE = '23514';
  END IF;
  -- Permit the internal parent-row serialization write without a domain revision.
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.ownership_revision NOT IN (OLD.ownership_revision, OLD.ownership_revision + 1) THEN
    RAISE EXCEPTION 'Workspace revision must advance consecutively' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind <> OLD.kind AND NOT (
    OLD.kind = 'PERSONAL' AND NEW.kind = 'ORGANIZATION' AND
    OLD.lifecycle_status = 'ACTIVE' AND NEW.lifecycle_status = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'Unsupported workspace kind transition' USING ERRCODE = '23514'; END IF;
  IF NEW.lifecycle_status <> OLD.lifecycle_status AND NOT (
    (OLD.lifecycle_status = 'ACTIVE' AND NEW.lifecycle_status = 'CLOSING') OR
    (OLD.lifecycle_status = 'CLOSING' AND NEW.lifecycle_status = 'CLOSED')
  ) THEN RAISE EXCEPTION 'Invalid workspace lifecycle transition' USING ERRCODE = '23514'; END IF;
  IF (OLD.closing_at IS NOT NULL AND NEW.closing_at IS DISTINCT FROM OLD.closing_at) OR
     (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION 'Closure timestamps are immutable once recorded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_workspace_guard BEFORE INSERT OR UPDATE OR DELETE ON provider_workspaces
  FOR EACH ROW EXECUTE FUNCTION guard_provider_workspace();

CREATE FUNCTION guard_workspace_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.display_color IS DISTINCT FROM OLD.display_color OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN RAISE EXCEPTION 'Membership identity and color are immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_identity_guard BEFORE UPDATE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_workspace_membership_identity();
CREATE TRIGGER membership_structure_lock BEFORE INSERT OR UPDATE OR DELETE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION lock_workspace_structure();

CREATE FUNCTION guard_organization_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'Profile starts at revision one' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.revision <> OLD.revision + 1
  ) THEN RAISE EXCEPTION 'Invalid profile identity or revision' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_profile_guard BEFORE INSERT OR UPDATE ON organization_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_organization_profile();
CREATE TRIGGER organization_profile_structure_lock BEFORE INSERT OR UPDATE OR DELETE ON organization_profiles
  FOR EACH ROW EXECUTE FUNCTION lock_workspace_structure();

CREATE FUNCTION guard_personal_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w provider_workspaces%ROWTYPE;
BEGIN
  SELECT * INTO STRICT w FROM provider_workspaces WHERE id = NEW.workspace_id;
  IF TG_OP = 'INSERT' THEN
    IF w.kind <> 'PERSONAL' OR w.lifecycle_status <> 'ACTIVE' OR NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL THEN
      RAISE EXCEPTION 'New allocation requires an ACTIVE PERSONAL workspace' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND role = 'OWNER') THEN
      RAISE EXCEPTION 'Allocation must be established for the PERSONAL owner' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR
       NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.allocated_at IS DISTINCT FROM OLD.allocated_at THEN
      RAISE EXCEPTION 'Allocation identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.released_at IS NOT NULL THEN
      IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Released allocation is immutable' USING ERRCODE = '23514'; END IF;
    ELSIF w.lifecycle_status <> 'CLOSED' OR NEW.released_at IS DISTINCT FROM w.closed_at OR NEW.release_reason IS DISTINCT FROM 'WORKSPACE_CLOSED'::"PersonalAllocationReleaseReason" THEN
      RAISE EXCEPTION 'Allocation releases only on full workspace closure' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Alphabetical trigger order acquires the parent write before reading state.
CREATE TRIGGER allocation_a_structure_lock BEFORE INSERT OR UPDATE OR DELETE ON personal_workspace_allocations
  FOR EACH ROW EXECUTE FUNCTION lock_workspace_structure();
CREATE TRIGGER allocation_b_guard BEFORE INSERT OR UPDATE ON personal_workspace_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_personal_allocation();

CREATE FUNCTION release_closed_workspace_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_status = 'CLOSED' AND OLD.lifecycle_status <> 'CLOSED' THEN
    UPDATE personal_workspace_allocations SET released_at = NEW.closed_at, release_reason = 'WORKSPACE_CLOSED'
      WHERE workspace_id = NEW.id AND released_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_release_allocations AFTER UPDATE ON provider_workspaces
  FOR EACH ROW EXECUTE FUNCTION release_closed_workspace_allocations();

CREATE FUNCTION check_workspace_structure() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF (SELECT count(*) FROM workspace_memberships WHERE workspace_id = target) <> 1 THEN
      RAISE EXCEPTION 'PERSONAL requires exactly one membership' USING ERRCODE = '23514';
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
CREATE CONSTRAINT TRIGGER workspace_structure_check AFTER INSERT OR UPDATE ON provider_workspaces
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workspace_structure();
CREATE CONSTRAINT TRIGGER membership_workspace_check AFTER INSERT OR UPDATE ON workspace_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workspace_structure();
CREATE CONSTRAINT TRIGGER profile_workspace_check AFTER INSERT OR UPDATE ON organization_profiles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workspace_structure();
CREATE CONSTRAINT TRIGGER allocation_workspace_check AFTER INSERT OR UPDATE ON personal_workspace_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workspace_structure();
