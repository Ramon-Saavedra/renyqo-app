# Listing workspace ownership and assignment (4.5.5)

Migration: `20261108150000_listing_workspace_assignment`.

## Canonical boundary

`Listing.workspaceId` owns the full lifecycle. `createdByMembershipId` is immutable provenance. `responsibleMembershipId` records one same-workspace member; it never grants authority independently of current membership/User authorization. There is no `providerId` ownership fallback or cross-workspace transfer operation.

The lifecycle is DRAFT → PUBLISHED / PAUSED → RENTED → RETIRED, with the explicit draft/pause/resume/retire transitions enforced in SQL. RETIRED is irreversible, retains evidence and has `displayOrder = NULL`. Non-retired ordering is workspace-wide and unique; create/reorder/retire serialize through the workspace root. Retirement compacts remaining positions in the same transaction.

`revision` is database-derived for semantic Listing changes. `assignmentSequence` is the sequence of responsibility evidence, not an authorization epoch. PostgreSQL requires complete append-only initial/transition evidence at commit, including net-zero responsibility changes inside one transaction.

OWNER direct reassignment requires the expected Listing revision. Assigning the current member is a no-op. The current responsible ACTIVE AGENT may request an eligible ACTIVE same-workspace AGENT; OWNER approves/rejects, with no target acceptance. Requests bind Listing, ownership and participant membership revisions, expiry and command identity. Approval and transition evidence commit atomically. Terminal requests cannot execute twice.

Suspension preserves responsibility but removes authority. Membership removal fails while non-retired responsibility remains, or follows an atomic reassignment in the caller's transaction. Retirement permits historical association with a removed member. Reinstatement and ownership transfer do not rewrite Listing responsibility.

Public Listing creation remains unavailable until the quota/entitlement integration. `ListingCreation` supplies the structural transaction and requires an explicit eligibility callback; it is not a public quota bypass.

## Access paths

Listing, assignment transitions and transfer requests have ENABLE + FORCE RLS. The restricted runtime uses tenant SELECT/INSERT/UPDATE checks, and cannot delete Listing/history. There is no public policy on base Listing. Composite foreign keys and immutable identities enforce same-workspace consistency independently of Prisma.

Public discovery/detail/saved-listing visibility use `public_listing_projections`. Its explicit allowlist includes public presentation/media fields and the existing applicant-facing income, document, household-size, pet and smoking requirements. Internal criteria revisions/evidence, member/workspace identifiers, storage keys and private street addresses are excluded. The exact street is projected only when the provider explicitly enables it. Triggers maintain publication/edits/withdrawal atomically; CLOSING withdraws all public rows at commit. The runtime has SELECT only.

Applicant consumers validate current User/session authority, resolve an owned Application through a bounded non-login helper, install exactly one tenant context, then revalidate ownership/domain eligibility. Foreign, nonexistent and inaccessible resources return the same not-found outcome. First admission resolves only a currently public projection, never private Listing access from a UUID alone. `listing_tenant_routes` is a private, immutable, FK-constrained routing projection; only narrow helper functions can read it. It is not ownership authority.

Profile edits use the separately approved `ProfileRevalidationTransactions` seam: User/session locks first, all sorted workspace roots, all sorted listings, then profile/application/queue mutations in one Serializable transaction. A dedicated non-login NOBYPASSRLS helper can inspect only listings related to that applicant's applications and returns only eligibility inputs. Its temporary identity is cleared before return. Ordinary tenant transactions cannot enter this seam or switch workspaces. CLOSING/CLOSED workspaces reject operational revalidation rather than promote applications there.

The expiry worker has a separate explicit SYSTEM purpose for a canonical pending viewing target. Its helper returns routing metadata only; the worker installs one scope and rechecks workspace, target and deadline under locks. Revoked human commands never fall back to SYSTEM.

ListingImage does not receive RLS in this release. Provider operations authorize the parent Listing before external work and again before mutation, and constrain every image selector to `image.listingId = authorizedListing.id`. Public media comes only from the public projection; applicant media comes through the owned-Application adapter. There is no independent HTTP image-ID authority.

Provider notification/realtime recipients are disabled until team fan-out. Creator/responsible membership is never a recipient fallback. Independently authorized applicant delivery remains enabled.

## Locking and retries

Assignment writes acquire sorted required User rows FOR SHARE → session grant → workspace root → sorted memberships → Listing → request/evidence → descendants. Participant discovery happens before the transaction; execution revalidates under locks. Missing/stale participant plans abort rather than acquire a new User lock late. Workspace root serialization also coordinates ordering, membership removal, retirement and ownership changes. Serializable retries preserve the expected Listing/membership/ownership revision checks.

Reads use bounded non-locking tenant transactions and current authority/resource revalidation before returning results. Applicant aggregate pages authorize each owned resource without switching tenant context. This is a bounded authorization window, not an assertion that delivered data can be recalled.

## Runtime credentials

`renyqo_application_runtime` is a NOLOGIN grant role inheriting `renyqo_workspace_runtime`; the existing foundation-only login remains separate. `scripts/provision-application-runtime.cjs` provisions a distinct LOGIN with NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION, no table/schema ownership or schema/database CREATE, and no transitive membership beyond the two runtime grant roles.

Reviewed legacy table grants are explicit in `src/provider-tenancy/application-runtime-grants.json`; no blanket table/default privileges are granted. USAGE is explicit for the queue and existing consideration-position INSERT-default sequences; queue/fairness derivation is unchanged. No runtime has access to ownership baselines or private routing persistence, nor role membership in schema owners/invariant/resolver/profile helper roles. Migration/admin credentials remain outside API/worker configuration.

After this operational cutover, production `PrismaService` invokes `assertApplicationRuntime`. Unlike the dormant 4.5.4 foundation verifier, this checks both RLS restrictions and required existing application/session/document/outbox grants. Failure prevents startup. There is no credential fallback.

## Coordinated deployment

1. Inventory API, session-store, document/expiry/outbox worker operations against the reviewed grant matrix. Rehearse the complete new schema/code/login combination on an isolated restore, including session writes, queues, documents, viewing, verification, public discovery and revocation races.
2. Provision the separate application login using `MIGRATION_DATABASE_URL` and `APPLICATION_DATABASE_URL` for the same database/schema. Keep migration/maintenance secrets out of runtime. Provisioning does not activate the login in old code. The old code cannot run against the new Listing schema.
3. Prepare the release and maintenance window. Quiesce provider writes and relevant workers, drain old API/worker/session pools, and record rollback/backup checkpoints. Do not let old binaries reconnect during migration.
4. Inventory disposable provider data with `scripts/reset-disposable-provider-data.cjs`. Supply `PROVIDER_RESET_DATABASE_URL`, matching `PROVIDER_RESET_DATABASE_NAME` and explicit `PROVIDER_RESET_SCHEMA`. Default mode only inventories. Review/export any test media references requiring external cleanup before removing metadata.
5. Apply the approved disposable reset with `PROVIDER_RESET_APPLY=true`, `ALLOW_DISPOSABLE_PROVIDER_RESET=4.5.5`, and `PROVIDER_WRITES_QUIESCED=true`. The tool checks the exact reviewed Listing FK graph, locks it, removes only related outbox rows and truncates that explicit graph in one transaction without CASCADE or disabled constraints. Global users/profiles/sessions/workspace/allocation history remain. It refuses canonical post-cutover Listing schemas. This tool is not a production-history deletion mechanism.
6. Run migrations using the migration credential. The Listing migration refuses nonempty legacy Listing data instead of mapping ARCHIVED into a new business state.
7. Start the coordinated new API/workers/session store using the new application login. Required grants must be applied before boot; production startup verifies them. Keep traffic stopped if any verification fails.
8. Run restricted-login smoke checks, including cross-tenant negatives, registration/login/logout, profile updates, application/queue operations, viewing/document recovery and outbox operations. Verify the actual login/backend, not SET ROLE from a superuser.
9. Resume traffic/workers only after smoke checks. Revoke access to obsolete application credentials. Never fall back to the old superuser/BYPASSRLS application secret. A schema rollback after this point requires the coordinated backup/release plan, not running old binaries against the new schema.

## Focused validation

```sh
npm run test:e2e -- --runTestsByPath test/listing-workspace-schema.e2e-spec.ts test/listing-tenant-isolation.e2e-spec.ts test/listing-assignment.e2e-spec.ts test/profile-listing-revalidation.e2e-spec.ts test/application-runtime.e2e-spec.ts test/application-runtime-api.e2e-spec.ts test/provider-cutover-reset.e2e-spec.ts
```

These tests use isolated schemas and actual restricted PostgreSQL logins. They supplement the existing application/queue/verification/viewing/document/outbox and 4.5.3/4.5.4 regression suites; focused results do not replace the complete regression gate.
