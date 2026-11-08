# Tenant isolation & PostgreSQL RLS — Phase 4.5.4

This bounded foundation follows the locked Phase 4.5 contract. No listing,
application, document, outbox, public discovery or applicant ownership is migrated.
RLS is tenant isolation, not membership, capability or entitlement authorization.
The existing operational routes remain outside this six-table protection boundary.

## Migrations and roles

Apply `20261108110000_workspace_tenant_context` then
`20261108120000_workspace_tenant_rls` through the deployment credential.
The latter enables **and forces** RLS on `provider_workspaces`,
`workspace_memberships`, `organization_profiles`, `ownership_transfer_intents`,
`personal_workspace_allocations` and `workspace_ownership_revision_baselines`.
It transfers those tables to the non-login `renyqo_workspace_owner` role.
No Prisma model or existing tenant FK needs changing: root `id` is canonical;
existing child `workspace_id` and transfer participant composites are retained.

The migration creates three cluster-wide, NOLOGIN, NOSUPERUSER, NOBYPASSRLS roles:

- `renyqo_workspace_owner`: DDL/table owner; only deployment may assume it.
- `renyqo_workspace_runtime`: SELECT/INSERT/UPDATE on five domain tables; no
  DELETE, TRUNCATE, schema CREATE or private-baseline privileges.
- `renyqo_workspace_invariants`: selected-tenant invariant/helper access,
  including private bookkeeping. Runtime must never be a member.

Deployment needs role-provisioning authority, or an administrator must pre-create
the exact roles and grant deployment the memberships/admin options needed by the
migration. Migration/deployment secrets are never application secrets. Exceptional
maintenance uses separate controlled administrative credentials, not the web pool.
No generic maintenance bypass or worker executor is introduced.

After migration, `scripts/provision-workspace-runtime.cjs` explicitly provisions
a separate login using `MIGRATION_DATABASE_URL` and
`WORKSPACE_RUNTIME_DATABASE_URL` for the same database. It refuses an existing
login with unsafe attributes/memberships, grants the runtime group and the minimal
global authority SELECT/row-lock privileges, and prints no credentials. Existing
global auth and legacy modules still require their separately reviewed application
grants; this script does not grant blanket access to every legacy table.

`assertRestrictedWorkspaceRuntime` remains an explicit validation entry point for
restricted-runtime tests and future deployment cutover. It rejects unsafe role
attributes/memberships, schema CREATE, table ownership, missing FORCE RLS and
excessive foundation/private-baseline privileges. Shared `PrismaService` startup
does not invoke it: the current application DATABASE_URL also serves legacy
modules and is not yet the final restricted workspace runtime credential.

## Context, bootstrap and creation

All tenant queries use the interactive transaction's client, never root Prisma.
`installTenantContext` validates UUIDs and rejects switching an established scope.
`TenantTransactions` reinstalls scope on each Serializable attempt; it is an
internal structural primitive, not an authorization grant or endpoint.

Only transaction-local `set_config(..., true)` is used. `app.workspace_id` is
valid only when `app.tenant_xid` equals the current top-level xid8. Missing,
malformed or stale context yields NULL and denies access. The stamp prevents
accidental session-level context from becoming usable on a later pooled request;
SET LOCAL alone restores a pre-existing session value. Deliberate arbitrary SQL
that forges both settings or a compromised runtime credential is outside this
trusted-server context boundary. Tenant scope is never proof of membership.

After global User/grant validation, `MembershipBootstrap` installs server-derived
`app.bootstrap_user_id`, candidate `app.bootstrap_workspace_id` and the same xid
stamp. Its SELECT-only policy exposes at most that user's one candidate membership
row, including membership metadata, not a cross-workspace directory. It cannot
read roots or write memberships. Missing/ineligible membership gives uniform 404.
No policy queries memberships recursively or uses an unrestricted definer.
After proof, bootstrap settings are cleared and tenant context is installed.
4.5.3 then re-reads current authority and expected epochs; protected writes retain
User → grant → workspace → sorted memberships → domain lock order until commit.

`WorkspaceCreation` requires session authority and an explicit eligibility callback,
generates prospective IDs outside retries, and creates root/OWNER/evidence in one
scoped transaction. No default eligibility, onboarding endpoint, entitlement or
anti-abuse policy is supplied. Closing/recreating is not product permission.
Scope stays installed through deferred commit checks. Nested helpers use the same
transaction; independent transactions, scope reset or earlier-savepoint rollback
inside protected work are prohibited.

Reads use short ReadCommitted scopes without authority row locks. Async policy
preparation is outside them; a fresh scoped authorization observation immediately
precedes the producer, which receives that transaction client. Sensitive handoff
closes the transaction before the existing synchronous enqueue contract. Pages,
batches and bounded stream chunks must reauthorize individually.

## Policies and invariant safety

Runtime policies use root `id`/child `workspace_id`: SELECT USING, INSERT WITH
CHECK, UPDATE USING plus WITH CHECK. Restrictive fences prevent an extra permissive
policy widening access. Membership SELECT explicitly permits the bounded bootstrap
branch only without ordinary tenant scope. No membership-status or lifecycle
filter hides rows from selected-workspace invariant checks. No DELETE is granted.

The migration hardens the existing invariant functions in place: qualified
relation/type/helper references, fixed trusted search paths with pg_temp last,
explicit matching-tenant assertions before work, restricted execution, and a
non-login, non-owner, NOBYPASSRLS definer role. Only the revision-lock entry point
is callable by runtime; trigger helpers/private baseline writes remain internal.
The migration tokenizes existing function bodies to preserve string literals and
retain the already tested domain algorithms rather than duplicate their SQL.

Exactly-one-OWNER and PERSONAL counts see every membership in the selected
workspace, including SUSPENDED/REMOVED history. Ownership baselines remain
transaction BEFORE-state evidence, never a second current-owner representation.
Global open-allocation occupancy is enforced by the existing partial unique index,
not a tenant-filtered absence check. Conversion/CLOSING retain occupancy; CLOSED
releases it once and preserves historical allocation evidence.

## Validation and rollout

Restricted-login suites:

`npm run test:e2e -- --runTestsByPath test/workspace-tenant-isolation.e2e-spec.ts test/workspace-tenant-invariants.e2e-spec.ts test/workspace-tenant-revocation.e2e-spec.ts test/workspace-runtime-provisioning.e2e-spec.ts`

They seed isolated schemas through the test administrator, apply RLS, create actual
restricted logins with fresh connections, and use those logins for proof operations.
Cleanup removes only their schema/login. Existing historical domain fixtures stop
before the RLS migration to retain their original contract; these new suites supply
the separate mandatory RLS/invariant/revocation proof, not superuser impersonation.

Tests cover cross-tenant ORM/raw SQL, bounded bootstrap, actual same-backend pool
reuse after commit/rollback and session poisoning, context errors, retries,
creation, owner/membership/allocation invariants and both commit orders for all six
4.5.3 revocation cases. Existing indexes remain usable under runtime EXPLAIN;
small fixtures may legitimately choose sequential scans. No broad index was added.
Stamped reads allocate an otherwise unnecessary xid and add context/bootstrap
round trips; monitor latency, transaction-ID consumption and vacuum health under
production load. These checks are not a production throughput benchmark.

Provision roles before rollout, quiesce structural writers for DDL/function
replacement, run migration/security/regression checks, validate restricted credentials separately. Switching the shared application
credential requires the later reviewed application cutover. Do not reset development/production data or silently
fall back to owner credentials. 4.5.4 cannot pass its exit gate without real
restricted-login proof; production restricted-role verification remains a future cutover gate.
