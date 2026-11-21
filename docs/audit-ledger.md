# Audit ledger — Phase 4.5.10, Slice 1

This page records the Slice 1 baseline. The opt-in execution/query foundations and
additional controlled helper grants are documented in [Slice 2](audit-context.md).

This is a dormant storage/security foundation. It does not adopt existing business
mutations, record access, activate onboarding, ownership transfer or removal,
provide a query endpoint, or claim complete audit coverage. No historical events
are backfilled. Slice 2 and later domain adoption require separate approval.

## Storage contract

`AuditEvent` records tenant, actor references, action/schema version, resource,
optional future listing/revision/evidence references, business/recording times,
source, correlation/causation and command scope/effect identity. Actor references
are evidence, never authority. There is no new security epoch, global command-ID
uniqueness or global commit-order promise. Actor UUIDs are validated at insertion
without cascading identity FKs. Names and other identity presentation are not
copied; the protected identity/hold architecture remains for later slices.

Only `audit.ledger.activated` V1 is registered. Its resource is the workspace,
source is INTERNAL, changes is empty and metadata is exactly `{activationVersion:1}`.
It reserves a genuine future activation boundary; this slice does not emit it
automatically. Routing/revision/source-evidence fields and INTEGRATION are reserved
in storage but rejected by this action's contract. New actions require explicit
forward database validation and matching typed contracts, not arbitrary JSON.

## Payload and persistence boundary

The private `AuditWriter` requires the caller's transaction and validates exact
keys/types. It has no root Prisma dependency or transaction creation. Database
constraints independently reject unknown/sensitive payload keys and non-matching
action versions. JSON payloads have an 8 KiB ceiling; invalid evidence is rejected,
never silently truncated. There is no blacklist-only generic entity serializer.

`AuditModule` has no exports and is not registered in AppModule. The invoker-only
`append_audit_event` primitive belongs to the existing non-login, NOBYPASSRLS
invariant role. Application runtime cannot execute it or access the table at all.
Future adoption must introduce a reviewed domain/authority adapter; passing actor
IDs or installing tenant context alone does not authorize an action.

## Database security and rollout

Three additive migrations separate storage, protections/RLS, and private append.
The existing workspace owner owns the table; ENABLE/FORCE RLS and restrictive
tenant policies reuse `current_workspace_id()` and its xid stamp. The invariant
role receives SELECT/INSERT only. PUBLIC and ordinary runtime have no table or
helper execution privileges. UPDATE/DELETE are also rejected by triggers.
TRUNCATE is denied by grants, including for the invariant role; the trusted
migrator retains the existing disposable-E2E reset/maintenance path without
disabling triggers. This is not superuser-proof/WORM storage.

The existing production runtime verifier now requires this schema and verifies
that runtime has no audit privileges. Deploy migrations before the new binary.
Old binaries remain compatible: no existing business table/trigger is changed.
Later mandatory-audit activation needs its own coordinated deployment gate.

Audit is separate from ApplicationActivity, ListingEvent, notifications, outbox,
logs, realtime and future Listing Akta. No audit outbox producer or delivery is
introduced. No pseudonymization, legal-hold administration or erasure executes.

## Validation

Focused specs: `audit-foundation`, `audit-security`, `audit-migration` E2E; payload
and writer unit specs. They use isolated schemas and real restricted logins.
The test-only invariant login simulates a future privileged adapter; it is not a
production application role. Runtime denial and invariant RLS are tested separately.
Existing listing migration parity/drift and tenant/revocation suites remain gates.
