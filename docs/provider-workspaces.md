# Provider Workspace foundation — Phase 4.5.1

This is an additive, dormant foundation. `ProviderWorkspacesModule` is registered
but has no controllers or exports. Existing provider registration, authentication,
listing ownership, delivery and application workflows are unchanged. Nothing in
this phase grants organization access or activates a commercial plan.

## Structures and canonical authority

- `ProviderWorkspace`: tenant UUID, PERSONAL/ORGANIZATION kind, display name,
  ACTIVE/CLOSING/CLOSED lifecycle, aggregate and ownership revisions, timestamps.
- `WorkspaceMembership`: only identity, user/workspace references, OWNER/AGENT
  role, immutable display color and creation time. Role is the only ownership
  designation. No owner pointer, membership lifecycle or transfer API exists.
- `OrganizationProfile`: organization-only current legal name (nullable),
  independent revision and timestamps. Display name is not verified legal identity.
- `PersonalWorkspaceAllocation`: historical allocation records. A partial unique
  index permits only one open reservation per user, not one lifetime allocation.

The creation caller supplies stable workspace, membership and allocation UUIDs.
Same-ID identical establishment retries return the existing initial state;
conflicting input or intervening workspace changes fail. Conversion requires the
current expected revision: a stale duplicate fails without additional effects.
Closure steps tolerate an exact immediately repeated transition and never release
capacity twice. These are persistence semantics, not public command receipts.

## Transaction and activation boundary

All mutation components require the caller's transaction. Use the shared
Serializable retry helper and allocate IDs outside its retry callback. The
creation advisory lock serializes same-workspace-ID retries. Child structural
writes serialize through a real parent-row write so stale PostgreSQL snapshots
fail/retry instead of validating against old membership/profile facts.

Before any operational caller is wired, its orchestration must enforce current
authentication/authorization (including retries), allocation anti-abuse eligibility,
effective entitlements, and required audit/outbox persistence in the same command
transaction. There are no permissive or fake policy adapters in this module.
Free allocation occupancy does not imply eligibility to immediately recreate a
workspace: that separately approved policy must be supplied before activation.

The closure methods are structural persistence operations. A future coordinator
must finish the locked cross-domain settlement before invoking completion. This
module does not claim to settle listings, applications, viewing deadlines,
integrations, billing or retention. It must not be used as an operational shortcut.

## Database guarantees

Apply `20261106150000_provider_workspace_foundation` through migrations, never
`db push`. It adds four empty tables and four enums; no existing data is reset.
No development/production database migration is applied by the test suite.

PostgreSQL owns these invariants in addition to domain validation:

- At most one OWNER via partial uniqueness, and at least one at transaction end.
  The designation does not depend on User status. Owner role swaps can use a
  transaction-local ownerless intermediate state, never an ownerless commit.
- PERSONAL has one membership and owner allocation evidence; ORGANIZATION has
  exactly one current profile and PERSONAL has none.
- Structural IDs, membership associations/color and allocation provenance are
  immutable. Structural DELETE is rejected; foreign keys use RESTRICT.
- Revisions are positive; workspace/profile updates advance consecutively.
- Lifecycle is ACTIVE → CLOSING → CLOSED, with consistent immutable closure times.
- An open allocation survives CLOSING and PERSONAL → ORGANIZATION conversion.
  The CLOSED database transition releases it atomically at `closedAt` with
  WORKSPACE_CLOSED attribution. Released records cannot be reopened or changed.
- New allocation insertion requires an ACTIVE PERSONAL workspace and its owner.
  Historical records survive and a user may allocate another workspace after full
  closure, subject to the separate eligibility policy.

Do not bypass these triggers or grant ordinary runtime TRUNCATE privileges. A
later controlled retention process needs explicitly reviewed database access;
ordinary cascades are not an erasure policy. Ownership transfer, member removal,
reverse kind conversion and profile-history retention are not implemented here.

## Integration contracts left intact

The exclusive future listing relation is immutable `Listing.workspaceId` →
`ProviderWorkspace.id`. No second column or writable legacy fallback is added to
current listings. Workspace conversion preserves workspace/member/allocation IDs;
cross-workspace listing reparenting is not supported.

The assigned cutover must replace provider-user predicates, ordering locks,
verification SQL authorization, read models, images, documents, notifications and
realtime together. Existing `providerType`, `companyName`, `providerId`, User role,
authVersion/session grants and all current lifecycle/fairness rules stay unchanged.

## Validation

`npm run test:e2e -- --runTestsByPath test/provider-workspaces.e2e-spec.ts test/provider-workspace-invariants.e2e-spec.ts`
uses the dedicated `renyqo_e2e` database with its explicit reset marker, creates a
unique isolated schema, replays every migration, and removes only that schema.
Tests exercise actual commit-time rejection, concurrent allocation, rollback,
conversion, closure and history retention. They do not approve an anti-abuse
policy, real payment, production closure settlement or operational activation.
