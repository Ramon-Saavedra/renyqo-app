CREATE TYPE "OwnershipTransferOutcome" AS ENUM ('DEMOTE_TO_AGENT', 'REMOVE_MEMBERSHIP');
CREATE TYPE "OwnershipTransferIntentStatus" AS ENUM ('PENDING_ACCEPTANCE', 'ACCEPTED', 'EXECUTED', 'CANCELLED');

CREATE TABLE ownership_transfer_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  current_owner_membership_id uuid NOT NULL,
  target_membership_id uuid NOT NULL,
  outcome "OwnershipTransferOutcome" NOT NULL,
  expected_ownership_revision integer NOT NULL CHECK (expected_ownership_revision > 0),
  expected_owner_membership_revision integer NOT NULL CHECK (expected_owner_membership_revision > 0),
  expected_target_membership_revision integer NOT NULL CHECK (expected_target_membership_revision > 0),
  status "OwnershipTransferIntentStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at timestamptz(3),
  executed_at timestamptz(3),
  cancelled_at timestamptz(3),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (current_owner_membership_id <> target_membership_id),
  FOREIGN KEY (current_owner_membership_id, workspace_id) REFERENCES workspace_memberships(id, workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (target_membership_id, workspace_id) REFERENCES workspace_memberships(id, workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX ownership_transfer_intents_workspace_id_status_created_at_id_idx
  ON ownership_transfer_intents(workspace_id, status, created_at, id);

-- One guard owns locking, lifecycle and timestamp derivation; it has no ordering
-- dependency on other triggers. Existing-child writes must already own the root.
CREATE FUNCTION guard_ownership_transfer_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w provider_workspaces%ROWTYPE; owner_row workspace_memberships%ROWTYPE;
  target_row workspace_memberships%ROWTYPE; observed_at timestamptz(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Transfer evidence cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM workspace_ownership_revision_baselines WHERE workspace_id = OLD.workspace_id
      AND transaction_id = pg_current_xact_id()::text
  ) THEN RAISE EXCEPTION 'Lock workspace before transfer intent updates' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.workspace_id, NEW.current_owner_membership_id, NEW.target_membership_id,
           NEW.outcome, NEW.expected_ownership_revision, NEW.expected_owner_membership_revision,
           NEW.expected_target_membership_revision, NEW.expires_at, NEW.confirmed_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.workspace_id, OLD.current_owner_membership_id, OLD.target_membership_id,
           OLD.outcome, OLD.expected_ownership_revision, OLD.expected_owner_membership_revision,
           OLD.expected_target_membership_revision, OLD.expires_at, OLD.confirmed_at, OLD.created_at) THEN
      RAISE EXCEPTION 'Confirmed transfer terms are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR
       NEW.executed_at IS DISTINCT FROM OLD.executed_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'Transfer revision and evidence timestamps are database-derived' USING ERRCODE = '23514';
    END IF;
  END IF;
  UPDATE provider_workspaces SET revision = revision WHERE id = NEW.workspace_id RETURNING * INTO w;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace missing' USING ERRCODE = '23503'; END IF;
  PERFORM id FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND
    id IN (NEW.current_owner_membership_id, NEW.target_membership_id) ORDER BY id FOR UPDATE;
  observed_at := clock_timestamp();

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_ACCEPTANCE' OR NEW.revision <> 1 OR NEW.accepted_at IS NOT NULL OR
       NEW.executed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Transfer establishes confirmed and awaiting acceptance' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := observed_at; NEW.confirmed_at := observed_at; NEW.updated_at := observed_at;
  ELSE
    IF NEW.status = 'EXECUTED' THEN
      RAISE EXCEPTION 'Transfer execution requires later authorization, capability, assignment, entitlement and audit integration'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'PENDING_ACCEPTANCE' AND NEW.status IN ('ACCEPTED', 'CANCELLED')) OR
      (OLD.status = 'ACCEPTED' AND NEW.status = 'CANCELLED')
    ) THEN RAISE EXCEPTION 'Invalid transfer intent transition' USING ERRCODE = '23514'; END IF;
    IF NEW.status <> OLD.status THEN
      NEW.revision := OLD.revision + 1; NEW.updated_at := observed_at;
      IF NEW.status = 'ACCEPTED' THEN NEW.accepted_at := observed_at; END IF;
      IF NEW.status = 'CANCELLED' THEN NEW.cancelled_at := observed_at; END IF;
    ELSE NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;

  -- Cancellation retains stale/expired evidence. Creation and acceptance (also
  -- acceptance retries) must revalidate the bound authority epochs and expiry.
  IF NEW.status <> 'CANCELLED' THEN
    SELECT * INTO owner_row FROM workspace_memberships WHERE id = NEW.current_owner_membership_id AND workspace_id = NEW.workspace_id;
    SELECT * INTO target_row FROM workspace_memberships WHERE id = NEW.target_membership_id AND workspace_id = NEW.workspace_id;
    IF w.kind <> 'ORGANIZATION' OR w.lifecycle_status <> 'ACTIVE' OR
       w.ownership_revision <> NEW.expected_ownership_revision OR
       owner_row.id IS NULL OR target_row.id IS NULL OR owner_row.id = target_row.id OR
       owner_row.role <> 'OWNER' OR owner_row.status <> 'ACTIVE' OR
       target_row.role <> 'AGENT' OR target_row.status <> 'ACTIVE' OR
       owner_row.revision <> NEW.expected_owner_membership_revision OR
       target_row.revision <> NEW.expected_target_membership_revision OR
       NEW.expires_at <= observed_at OR
       NOT EXISTS (SELECT 1 FROM users WHERE id = owner_row.user_id AND status = 'active') OR
       NOT EXISTS (SELECT 1 FROM users WHERE id = target_row.user_id AND status = 'active') THEN
      RAISE EXCEPTION 'Transfer terms are stale, expired or ineligible' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_transfer_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON ownership_transfer_intents
  FOR EACH ROW EXECUTE FUNCTION guard_ownership_transfer_intent();
