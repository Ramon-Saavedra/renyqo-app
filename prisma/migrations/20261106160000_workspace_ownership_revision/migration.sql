-- Membership roles remain the sole current ownership authority. This private
-- row records a transaction's BEFORE state, not a current-owner pointer. Keeping
-- the baseline until the next transaction also handles SET CONSTRAINTS IMMEDIATE
-- safely: an early deferred-check flush must not reset the transaction baseline.
CREATE TABLE workspace_ownership_revision_baselines (
  workspace_id uuid PRIMARY KEY REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  transaction_id varchar(20) NOT NULL,
  baseline_revision integer NOT NULL CHECK (baseline_revision > 0),
  baseline_membership_id uuid,
  asserted_revision integer CHECK (asserted_revision IS NULL OR asserted_revision = baseline_revision)
);

CREATE FUNCTION guard_workspace_ownership_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Ownership baseline is private trigger bookkeeping' USING ERRCODE = '23514';
  END IF;
  IF NEW.transaction_id <> pg_current_xact_id()::text OR
     (TG_OP = 'UPDATE' AND NEW.workspace_id <> OLD.workspace_id) THEN
    RAISE EXCEPTION 'Transaction ownership baseline is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transaction_id = NEW.transaction_id AND NOT (
    NEW.baseline_revision = OLD.baseline_revision AND
    NEW.baseline_membership_id IS NOT DISTINCT FROM OLD.baseline_membership_id AND
    OLD.asserted_revision IS NULL AND NEW.asserted_revision IS NOT DISTINCT FROM OLD.baseline_revision
  ) THEN RAISE EXCEPTION 'Transaction ownership baseline is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_baseline_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_ownership_revision_baselines
  FOR EACH ROW EXECUTE FUNCTION guard_workspace_ownership_baseline();

CREATE FUNCTION capture_workspace_ownership_baseline(target uuid, initial_revision integer, establishing boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous_membership uuid;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'Ownership baseline capture requires a workspace trigger' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_ownership_revision_baselines
    WHERE workspace_id = target AND transaction_id = pg_current_xact_id()::text) THEN RETURN; END IF;
  IF NOT establishing THEN
    SELECT id INTO previous_membership FROM workspace_memberships WHERE workspace_id = target AND role = 'OWNER';
    IF NOT FOUND THEN RAISE EXCEPTION 'Established workspace requires an OWNER' USING ERRCODE = '23514'; END IF;
  END IF;
  INSERT INTO workspace_ownership_revision_baselines(workspace_id, transaction_id, baseline_revision, baseline_membership_id)
    VALUES (target, pg_current_xact_id()::text, initial_revision, previous_membership)
    ON CONFLICT (workspace_id) DO UPDATE SET transaction_id = EXCLUDED.transaction_id,
      baseline_revision = EXCLUDED.baseline_revision, baseline_membership_id = EXCLUDED.baseline_membership_id,
      asserted_revision = NULL;
END $$;

CREATE FUNCTION initialize_workspace_ownership_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM capture_workspace_ownership_baseline(NEW.id, NEW.ownership_revision, true);
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_ownership_baseline_initial AFTER INSERT ON provider_workspaces
  FOR EACH ROW EXECUTE FUNCTION initialize_workspace_ownership_baseline();

-- The BEFORE root guard rejects counter assignment and captures the baseline;
-- AFTER records the checked assertion. No alphabetical trigger ordering is used.
CREATE FUNCTION assert_workspace_ownership_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM capture_workspace_ownership_baseline(OLD.id, OLD.ownership_revision, false);
  UPDATE workspace_ownership_revision_baselines SET asserted_revision = baseline_revision
    WHERE workspace_id = OLD.id AND transaction_id = pg_current_xact_id()::text AND asserted_revision IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_ownership_revision_assertion AFTER UPDATE OF ownership_revision ON provider_workspaces
  FOR EACH ROW EXECUTE FUNCTION assert_workspace_ownership_revision();

CREATE OR REPLACE FUNCTION guard_provider_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE baseline workspace_ownership_revision_baselines%ROWTYPE; designated uuid; derived_revision integer;
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
  IF NEW.ownership_revision IS DISTINCT FROM OLD.ownership_revision THEN
    RAISE EXCEPTION 'Ownership revision is database-derived' USING ERRCODE = '23514';
  END IF;
  -- The parent tuple is already write-locked before this trigger. Snapshot only
  -- once per transaction, before any permitted canonical role mutation.
  PERFORM capture_workspace_ownership_baseline(OLD.id, OLD.ownership_revision, false);
  SELECT * INTO STRICT baseline FROM workspace_ownership_revision_baselines WHERE workspace_id = OLD.id;
  SELECT id INTO designated FROM workspace_memberships WHERE workspace_id = OLD.id AND role = 'OWNER';
  IF designated IS NOT NULL THEN
    derived_revision := baseline.baseline_revision + CASE
      WHEN baseline.baseline_membership_id IS NULL OR designated = baseline.baseline_membership_id THEN 0 ELSE 1 END;
    IF derived_revision <> OLD.ownership_revision THEN
      NEW.ownership_revision := derived_revision;
      IF NEW.revision = OLD.revision THEN NEW.revision := OLD.revision + 1; END IF;
      NEW.updated_at := clock_timestamp();
    END IF;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
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

-- The supported structural entry point locks/checks the parent before child
-- UPDATE tuple locks. It performs no transfer, grants or membership lifecycle.
CREATE FUNCTION lock_workspace_ownership_revision(target uuid, expected_revision integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE actual integer;
BEGIN
  IF expected_revision < 1 OR expected_revision IS NULL THEN
    RAISE EXCEPTION 'Expected ownership revision is required' USING ERRCODE = '23514';
  END IF;
  UPDATE provider_workspaces SET ownership_revision = expected_revision
    WHERE id = target AND ownership_revision = expected_revision RETURNING ownership_revision INTO actual;
  IF NOT FOUND OR actual <> expected_revision THEN
    RAISE EXCEPTION 'Ownership revision changed' USING ERRCODE = '23514';
  END IF;
  RETURN actual;
END $$;

CREATE OR REPLACE FUNCTION lock_workspace_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE baseline workspace_ownership_revision_baselines%ROWTYPE; ownership_change boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workspace structural history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  -- Do not wait for a parent while holding an existing child tuple lock.
  -- A current baseline proves the transaction acquired the parent write first.
  IF TG_OP = 'UPDATE' AND NOT EXISTS (SELECT 1 FROM workspace_ownership_revision_baselines
    WHERE workspace_id = NEW.workspace_id AND transaction_id = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Lock workspace before structural child updates' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'workspace_memberships' THEN
    IF TG_OP = 'INSERT' THEN ownership_change := NEW.role = 'OWNER';
    ELSE ownership_change := OLD.role <> NEW.role AND (OLD.role = 'OWNER' OR NEW.role = 'OWNER'); END IF;
    IF ownership_change THEN
      SELECT * INTO baseline FROM workspace_ownership_revision_baselines
        WHERE workspace_id = NEW.workspace_id AND transaction_id = pg_current_xact_id()::text;
      IF NOT FOUND OR (baseline.baseline_membership_id IS NOT NULL AND baseline.asserted_revision IS DISTINCT FROM baseline.baseline_revision) THEN
        RAISE EXCEPTION 'Check expected ownership revision before changing OWNER' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  UPDATE provider_workspaces SET revision = revision WHERE id = NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace is missing' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION finalize_workspace_ownership_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; baseline workspace_ownership_revision_baselines%ROWTYPE;
  designated uuid; actual integer; derived_revision integer;
BEGIN
  IF TG_TABLE_NAME = 'provider_workspaces' THEN target := NEW.id; ELSE target := NEW.workspace_id; END IF;
  IF (SELECT count(*) FROM workspace_memberships WHERE workspace_id = target AND role = 'OWNER') <> 1 THEN
    RAISE EXCEPTION 'Established workspace requires exactly one OWNER' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT baseline FROM workspace_ownership_revision_baselines
    WHERE workspace_id = target AND transaction_id = pg_current_xact_id()::text;
  SELECT id INTO STRICT designated FROM workspace_memberships WHERE workspace_id = target AND role = 'OWNER';
  derived_revision := baseline.baseline_revision + CASE
    WHEN baseline.baseline_membership_id IS NULL OR designated = baseline.baseline_membership_id THEN 0 ELSE 1 END;
  SELECT ownership_revision INTO STRICT actual FROM provider_workspaces WHERE id = target;
  IF actual <> derived_revision THEN
    -- The root guard derives the counter and advances the workspace revision.
    -- Only a mismatch writes, so newly queued checks converge rather than recur.
    UPDATE provider_workspaces SET revision = revision WHERE id = target;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_ownership_revision_check AFTER INSERT OR UPDATE ON provider_workspaces
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finalize_workspace_ownership_revision();
CREATE CONSTRAINT TRIGGER membership_ownership_revision_check AFTER INSERT OR UPDATE ON workspace_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finalize_workspace_ownership_revision();
