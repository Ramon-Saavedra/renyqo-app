# Authorization context & revocation — Phase 4.5.3

This bounded foundation follows [4.5.1](provider-workspaces.md) and
[4.5.2](provider-memberships.md). `ProviderAuthorizationModule` has no controllers,
exports or default allow adapters. Registering it changes no legacy endpoint.
No schema, migration, RLS, job infrastructure or capability persistence is added.

## Layers and facts

Existing Passport/session validation remains the global authentication boundary.
`sessionAuthorityFromRequest` captures only an already authenticated server User,
authVersion and the real request SID. Never deserialize an authority reference from
request bodies, headers or queue payloads controlled by a client. SIDs are secrets;
contexts/references are server-only and must not be returned in DTOs or logged.

`GlobalAuthorityReader` validates ACTIVE User/authVersion, grant ownership/version,
expiry and physical session authentication snapshot. `WorkspaceAuthorityReader`
loads these facts plus canonical workspace/membership facts in one primary-database
statement. `WorkspaceMembershipResolver` resolves by authenticated userId and
selected workspaceId, never by a client membershipId or the first available member.
An expected membershipId is a precondition, not identity evidence.

The frozen context contains only authority mode, userId/authVersion, SID where
applicable, workspaceId, membershipId, role, ACTIVE status, membership revision,
workspace lifecycle and ownershipRevision when explicitly bound. No global PROVIDER
role, profile, capability map or entitlement snapshot proves workspace authority.
The context is an observation, never a durable token or cached allow decision.

Eligibility does not grant a domain operation. Every read/write wrapper requires
an explicit domain-owned policy; there are no default policies. The policy must
authorize the requested action/resources and permitted fields, throwing on denial.
Policies receive a frozen action/resource requirement. Mutation callbacks also
receive that captured requirement, avoiding reliance on mutable request selection.
Use immutable domain command inputs and domain-owned expected business revisions.

`requireVisibleWorkspaceResource` provides a uniform foreign/missing resource 404
for a **server-loaded canonical reference**. It checks tenant consistency only;
it is not assignment/capability authorization. Query/count/pagination predicates
must apply domain visibility during result production. There is no legacy
providerId-to-workspace inference or working listing cutover in this phase.

## Authority modes

- SESSION_BOUND requires current User/authVersion, membership and the originating
  durable session grant and expiry. Logout/grant deletion stops subsequent work.
- USER_DELEGATED binds server-derived User/workspace/membership identities,
  authVersion, membership revision, optional ownershipRevision, action and resource
  bounds. `delegateContext` captures these without retaining a SID. The originating
  browser may log out; current account/membership state and expected epochs must
  still match. Resource-bounded references cannot expand to other resources or an
  empty workspace-wide request. Do not refresh old expected epochs to rescue a job.
- SYSTEM has an explicit purpose/workspace/action/resource contract and a
  purpose-specific policy interface. Human resolvers/coordinators reject SYSTEM.
  There is no system execution adapter, default system permission or silent
  conversion of revoked human work. Later system workers require separate review.

Only authority seams are implemented: no jobs, workers, queues or delegation table.
Delegation references express a bounded instruction, not a capability/scope catalog.

## Protected transaction protocol

`ProtectedWorkspaceTransactions.run` owns the outer transaction using the existing
bounded Serializable retry helper. Each attempt acquires:

1. User FOR SHARE, then the SID grant FOR SHARE for SESSION_BOUND; validate global
   state/epoch and grant ownership, authentication snapshot and expiry.
2. Workspace FOR SHARE for ordinary business work. STRUCTURAL plans instead call
   the existing `lock_workspace_ownership_revision` write/assertion helper first.
3. Actor and declared participating memberships in PostgreSQL UUID order, using
   FOR SHARE for business work or FOR UPDATE for structural work. Re-read and
   validate tenant identity, ACTIVE status, expected membership revision, required
   role, lifecycle and applicable ownershipRevision.
4. Domain policy locks dependencies and checks current resource/field visibility
   and business preconditions. Recheck session expiry after policy/lock waits.
5. Perform mutations on that same transaction; retain all authority locks through
   the outer commit. Required domain evidence must belong to that transaction.

FOR KEY SHARE is insufficient for non-key status/revision updates. Explicit
PostgreSQL lock_timeout (1.5 seconds) and statement_timeout (4 seconds) complement
the existing Prisma transaction timeout. Lock-timeout failures deny completion;
serialization retries rerun all authority and domain checks rather than reuse an
allow decision. Time-based expiry is checked after waits; this is not a promise of
an exact wall-clock commit deadline. Keep batches and command execution bounded.

Revocation updates/deletes conflict with these locks. If revocation commits first,
the protected attempt observes rejection or aborts/retries and is rejected. If
protected work holds its locks first, revocation waits and commits after that work.
A delayed HTTP response does not invalidate an earlier committed mutation.

Structural plans declare participant writes before locking, preserving existing
workspace-first membership/baseline enforcement without lock upgrades. Normal
business callbacks must never update these authority rows or upgrade their locks.
Global credential/account mutation orchestration is not implemented by this runner.
Existing password reset/global revocation and logout already conflict on User/grant.

No external I/O, manual COMMIT, independent mutation transaction or rollback to a
savepoint that releases authority locks is allowed inside the callbacks. Never
acquire an earlier authority tier after taking a later resource lock. Multi-User,
multi-grant or multi-workspace commands are not supported by this coordinator;
they need a separately reviewed deterministic acquisition plan, not nested runs.

Later canonical order continues with idempotency reservation, entitlement/quota
dependencies, listing/resource, then assignment/application/document descendants.
Domain adapters must respect it. The existing parent-write protocol means a
membership revocation waits for other protected writers in that workspace too.

## Lifecycle and reads

ACTIVE permits domain policy evaluation. SUSPENDED and REMOVED deny workspace
authority. A suspended OWNER keeps designation without access. Recorded listing
responsibility grants no authority and is never changed by this module.

CLOSING denies OPERATIONAL requests. HISTORY, SECURITY and CLOSURE_SETTLEMENT are
eligible only for their explicit domain policies. CLOSED permits evaluation only
of HISTORY/SECURITY. Neither category nor lifecycle is a blanket history grant.

`AuthorizedWorkspaceReads.query` loads current authority, runs the domain policy,
then revalidates authority immediately before invoking protected result production.
A changed epoch/lifecycle during asynchronous policy work rejects that observation.
It uses no locking transaction and no cross-request authorization cache. Each
page/batch/chunk calls the helper again. The producer must query scoped data
promptly; it must not defer production behind unrelated asynchronous work.

For sensitive results delayed after production, `handoff` revalidates authority and
domain policy again immediately before the synchronous transport enqueue callback.
The callback must return `undefined`, not `void`/Promise. Native async functions
are rejected before invocation; unchecked non-undefined returns are rejected too.
Runtime rejection cannot cancel work an unchecked callback already started, or
detect detached asynchronous work followed by an undefined return. Do not do
asynchronous preparation inside that callback. These helpers define
a bounded authorization-to-delivery window, not the write commit fence. Delivered
bytes or data irrevocably handed to transport cannot be recalled. No realtime
team fan-out, streaming engine, signed-URL or document-storage redesign is included.

## Retry and receipt boundary

Every wrapper invocation and Serializable attempt reauthorizes. Denied authority
never reaches a receipt replay callback. A previous successful command is not
authority to replay its protected result after revocation. Previously failed work
also cannot execute after revocation.

`bindCommand`/`assertSameCommand` compare actor, tenant, command identity, action and
the domain's canonical input fingerprint. They neither authorize receipt access nor
persist receipts. Domain adapters own canonical fingerprinting, idempotency locking,
receipt persistence and current resource/field projection before any protected replay.
The E2E fixture's resource/receipt tables exist only in isolated test schemas.

## Activation boundaries and validation

Existing ProviderOnlyGuard remains unchanged for legacy product-entry compatibility.
It proves no membership, OWNER/AGENT role, assignment, capability or financial access.
Legacy listing/application/document endpoints are **not** made workspace-revocation
safe by registering this foundation. A new integrated caller must use the coordinator
and domain policy. Raw SQL/other repositories that bypass it are outside its guarantee;
RLS and descendant tenant constraints belong to 4.5.4.

Operational removal, reinstatement and ownership transfer remain blocked by 4.5.2.
Authorization does not supply missing assignment repair, seat approval, capability/
scope reset or audit evidence. Missing later policy/integration must fail closed.

Focused tests:
`npm run test:e2e -- --runTestsByPath test/provider-authorization-context.e2e-spec.ts test/provider-authorization-revocation.e2e-spec.ts`

They replay migrations in isolated schemas of the marked renyqo_e2e database.
Race tests synchronize on actual pg_blocking_pids and prove both commit orders for
membership suspension/removal, account status/authVersion, logout and CLOSING.
Revocation-first tests observe real Serializable retries. No sleeps/mock permissions
are used to stand in for lock contention. A short pg_sleep tests natural expiry only.
