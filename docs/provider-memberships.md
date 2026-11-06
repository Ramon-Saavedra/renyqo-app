# Membership, OWNER & AGENT foundation — Phase 4.5.2

This additive foundation extends [4.5.1](provider-workspaces.md).
`ProviderMembershipsModule` has no controllers or exports. Its caller-owned
transaction components are private persistence operations, not operational APIs.
Authentication, legacy listing/provider ownership and global User roles are unchanged.

## Canonical membership

Membership retains its UUID, workspace/user references, immutable color and original
creation time. `role = OWNER | AGENT` remains the only current ownership designation.
`status = ACTIVE | SUSPENDED | REMOVED` is independent of the role. ACTIVE and
SUSPENDED consume a seat; REMOVED does not. Seat occupancy is not capacity approval.
Suspended OWNER retains designation; REMOVED OWNER is prohibited.

One database-derived `revision`, initially 1, advances once per actual role/status
update, including combined changes. No-ops preserve revision and updatedAt.
Returning to a prior state still advances the membership epoch. Rollback restores
the previous state. Future capability/scope changes must use this same authority
epoch; they must not introduce parallel security versions.

All ACTIVE/SUSPENDED/REMOVED transitions are supported structurally except
REMOVED → SUSPENDED. REMOVED → ACTIVE restores the same row as AGENT, preserving
history and never restoring historical ownership. Workspace/user uniqueness spans
removed history. PERSONAL permits exactly one non-REMOVED membership, with removed
historical rows retained; this introduces no PERSONAL team or recovery operation.

## Responsibility and dormant commands

Suspension changes no listing responsibility, global User status or authVersion.
Recorded responsibility remains until explicit reassignment and grants no authority.
4.5.3 must deny suspended/removed members and respect current membership revisions.
4.5.5 must expose ineligible responsibility and support explicit reassignment.
Once assignment exists, removal must repair required assignments atomically or fail.

Removal and reinstatement commands explicitly refuse execution. Reinstatement needs
real seat entitlement validation (4.5.7); removal needs assignment integration
(4.5.5). Resume uses an existing seat and restores no future grants automatically.
Even suspension/resume persistence is unavailable operationally: authenticated,
authorized orchestration and durable audit integration (4.5.10) must precede activation.
There are no permissive policy adapters or fake approvals.

## Confirmed transfer intents

The intent stores its workspace, two membership participants, explicit outcome,
expected ownership/membership revisions, confirmation, acceptance, expiry,
lifecycle/revision and timestamps. These participant references are bound historical
terms, never a second source of current ownership. No capability/scope/preset fields
or access-reset model exists.

Creation represents owner confirmation of the selected outcome; only the bound
target may accept the same intent in the private orchestration. Authenticated actor
binding and required reauthentication remain activation dependencies. Bound terms
are immutable. Server time and current tenant/role/status/revisions are checked by
PostgreSQL after locking on creation and acceptance, including retries. Reusing an
intent ID with changed terms fails. Changed membership epochs, expiry or ownership
make acceptance invalid even if role/status later return. ACCEPTED is evidence of
acceptance, not current authority or a guarantee of continuing eligibility.
Cancellation retains evidence, including expired/stale terms. Revision-checked
responses have one winner; identical current-version retries are no-ops.

Structural outcome plans are:

- DEMOTE_TO_AGENT: former OWNER becomes ACTIVE AGENT; target becomes ACTIVE OWNER;
  seat usage unchanged.
- REMOVE_MEMBERSHIP: former OWNER becomes AGENT + REMOVED atomically; target becomes
  ACTIVE OWNER; former owner stops consuming a seat, preserving attribution/history.

Each participating membership advances once; ownershipRevision advances once for
the net canonical OWNER change. Existing 4.5.1 exactly-one-OWNER enforcement remains.
The locked eventual demotion result is standard operational AGENT access, ASSIGNED
scope and no sensitive-finance delegation, supplied by the later canonical integration.

**Execution is blocked in both the private command and the database.** EXECUTED is
reserved but unreachable in this phase, including through raw SQL. No intent can
complete, twice or otherwise. A later reviewed forward migration must replace this
block only alongside real authorization, capability/scope, assignment, entitlement
and audit integration, and invalidate competing intents/invitations atomically.
Structural role-swap tests prove the invariant foundation, not an operational transfer.
No public confirmation, acceptance or transfer endpoint exists.

## Persistence and locking

Apply the forward migrations `20261106170000_workspace_membership_lifecycle` and
`20261106171000_ownership_transfer_intents` after both 4.5.1 migrations. Existing
members backfill to ACTIVE/revision 1 and updatedAt = createdAt without changing
identity, role, color or ownershipRevision. These are membership baselines, not
inferred global account status. No applied migration is rewritten; never use db push.

Caller transactions use Serializable with the shared bounded serialization retry
helper. Allocate stable IDs outside retries. First write-lock/check the workspace
through `lock_workspace_ownership_revision`; then lock participating memberships
in PostgreSQL UUID order, then the intent. The parent write also serializes same-ID
creation retries; global intent-ID uniqueness rejects cross-workspace collisions.
Existing-child updates lacking the current
parent transaction baseline fail before waiting for a parent. No-ops still serialize.
Never start a membership/intent write while retaining a child lock from another
workspace; multi-workspace orchestration needs a separately reviewed lock order.

SQL enforces lifecycle, immutable identities/confirmed terms, revision derivation,
history deletion guards, composite same-workspace participant FKs, positive versions,
PERSONAL cardinality, and existing ownership/closure/allocation invariants.
Do not bypass triggers or grant runtime TRUNCATE rights. Structural SQL is not
authentication, audit or operational authorization. No new dev/production migration
is applied by validation; tests replay migrations in isolated E2E schemas only.

## Validation

`npm run test:e2e -- --runTestsByPath test/provider-membership-lifecycle.e2e-spec.ts test/ownership-transfer-intents.e2e-spec.ts test/membership-lifecycle-migration.e2e-spec.ts test/provider-workspaces.e2e-spec.ts test/provider-workspace-invariants.e2e-spec.ts test/workspace-ownership-revision.e2e-spec.ts`

The dedicated `renyqo_e2e` database and explicit reset marker are required. Tests use
real PostgreSQL, isolated schemas and actual commit/concurrency/rollback behavior.
