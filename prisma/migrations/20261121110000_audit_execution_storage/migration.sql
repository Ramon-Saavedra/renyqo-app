BEGIN;
CREATE TABLE audit_actor_identities (
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  actor_kind "AuditActorKind" NOT NULL,actor_user_id uuid,actor_membership_id uuid,
  snapshot jsonb,captured_at timestamptz(3) NOT NULL,
  CONSTRAINT audit_identity_tenant_key UNIQUE(id,workspace_id),
  CONSTRAINT audit_identity_snapshot CHECK ((
    (actor_kind='SYSTEM' AND snapshot IS NULL) OR
    (actor_kind IN('MEMBER','USER') AND jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=8192)) IS TRUE),
  CONSTRAINT audit_identity_allowlist CHECK ((actor_kind='SYSTEM' OR (
    snapshot->'snapshotVersion'='1'::jsonb AND jsonb_typeof(snapshot->'actorDisplayNameAtTime')='string'
    AND jsonb_typeof(snapshot->'capturedAt')='string' AND isfinite((snapshot->>'capturedAt')::timestamptz)
    AND ((actor_kind='USER' AND (snapshot-ARRAY['snapshotVersion','actorDisplayNameAtTime','capturedAt'])='{}'::jsonb)
      OR (actor_kind='MEMBER' AND
        (snapshot-ARRAY['snapshotVersion','actorDisplayNameAtTime','capturedAt','actorUserId','actorMembershipId','actorWorkspaceId','actorRoleAtTime','actorColorAtTime'])='{}'::jsonb
        AND snapshot->>'actorUserId'=actor_user_id::text AND snapshot->>'actorMembershipId'=actor_membership_id::text
        AND snapshot->>'actorWorkspaceId'=workspace_id::text AND snapshot->>'actorRoleAtTime' IN('OWNER','AGENT')
        AND jsonb_typeof(snapshot->'actorColorAtTime')='string')))) IS TRUE)
);
CREATE TABLE audit_execution_contexts (
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL,transaction_id varchar(20) NOT NULL,
  actor_kind "AuditActorKind" NOT NULL,actor_user_id uuid,actor_membership_id uuid,system_purpose varchar(80),
  snapshot jsonb,captured_at timestamptz(3) NOT NULL,source "AuditSource" NOT NULL,
  command_id uuid NOT NULL,command_scope varchar(120) NOT NULL,correlation_id uuid NOT NULL,causation_id uuid,
  required_effects text[] NOT NULL
);
ALTER TABLE audit_events ADD COLUMN actor_identity_id uuid;
CREATE INDEX audit_execution_transaction ON audit_execution_contexts(transaction_id,id);
CREATE INDEX audit_event_execution_effect ON audit_events(actor_identity_id,effect_key);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_identity_id_workspace_id_fkey
  FOREIGN KEY(actor_identity_id,workspace_id) REFERENCES audit_actor_identities(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE audit_events DROP CONSTRAINT audit_event_foundation;
ALTER TABLE audit_events ADD CONSTRAINT audit_event_foundation CHECK (
  resource_type='WORKSPACE' AND resource_id=workspace_id
  AND command_scope='audit.ledger.activation' AND effect_key~'^[a-z][a-z0-9_.:-]{0,79}$'
  AND listing_id IS NULL AND resource_revision_before IS NULL AND resource_revision_after IS NULL
  AND revision_kind IS NULL AND source_evidence_type IS NULL AND source_evidence_id IS NULL);
DO $migration$ DECLARE s text:=current_schema();t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_actor_identities','audit_execution_contexts'] LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner',s,t);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,renyqo_workspace_runtime,renyqo_workspace_invariants',s,t);
    EXECUTE format('GRANT SELECT,INSERT ON %I.%I TO renyqo_workspace_invariants',s,t);
  END LOOP;
  EXECUTE format('GRANT DELETE ON %I.audit_execution_contexts TO renyqo_workspace_invariants',s);
  EXECUTE format('CREATE POLICY audit_identity_tenant ON %I.audit_actor_identities TO renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,s,s);
  -- This PRIVATE transient table is xid-bound bookkeeping. Its routines also
  -- assert the existing selected tenant; no new tenant selector is installed.
  EXECUTE format('CREATE POLICY audit_execution_transaction ON %I.audit_execution_contexts TO renyqo_workspace_invariants USING(transaction_id=pg_current_xact_id()::text) WITH CHECK(transaction_id=pg_current_xact_id()::text)',s);
  EXECUTE format('CREATE TRIGGER audit_identity_immutable BEFORE UPDATE OR DELETE ON %I.audit_actor_identities FOR EACH ROW EXECUTE FUNCTION %I.reject_audit_event_mutation()',s,s);
END $migration$;
COMMIT;
