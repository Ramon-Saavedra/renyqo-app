# Audit Slice 4 — coverage and execution-boundary review

Status: Slice 4 implementation; validation results are reported separately.
Baseline: main `59dacfd`, including Audit Slices 1–3 (PRs 173–175).

## Mutation coverage matrix

Every resource below retains its immutable workspace ownership. Effect
keys are `listing.state:<listingId>` and `application.activity:<activityId>`,
scoped by the initiating command. Existing
receipts remain authoritative; server command IDs do not create HTTP idempotency.

| Domain / entry                                              | Existing transaction / authorization                                                                                              | Actor / resource                                                         | Before → after / existing evidence                                                                                   | Required Audit                                                                | Replay / availability                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ListingCreation.run / POST provider/listings                | protected structural transaction; listing.create capability, member and target eligibility, quota                                 | MEMBER / new Listing                                                     | absent → DRAFT; INITIAL assignment transition is also creation receipt                                               | provider.listing.created; preserve separate Slice 3 assignment fact          | receipt replay; active                                                  |
| ListingsService.update / PATCH listing                      | ProviderListingAccess.mutate; current scope and listing.write                                                                     | MEMBER / Listing                                                         | meaningful allowlisted fields changed; criteria revision and assessments when applicable                             | provider.listing.updated; changed field names, not field values              | no receipt; no meaningful change means no event; active                 |
| publish                                                     | same; DRAFT validation and required fields                                                                                        | MEMBER / Listing                                                         | DRAFT → PUBLISHED; conditional revision write                                                                        | provider.listing.published                                                   | stale/repeated transition conflicts; active                             |
| moveToDraft                                                 | same                                                                                                                              | MEMBER / Listing                                                         | PUBLISHED/PAUSED → DRAFT; viewing closure and activity invalidation                                                  | provider.listing.status_changed                                              | no receipt; active                                                      |
| pause / resume                                              | same                                                                                                                              | MEMBER / Listing                                                         | PUBLISHED ↔ PAUSED; resume reconciles queue                                                                          | provider.listing.status_changed; separate actual promotion effects           | no receipt; active                                                      |
| retire                                                      | same root; lifecycle validation                                                                                                   | MEMBER / Listing                                                         | operational status → RETIRED; closes viewings and compacts active ordering                                           | provider.listing.retired                                                     | irreversible; compaction is not a separate manual order command; active |
| ListingOrderingService.move / PATCH position                | protected workspace transaction; canonical OWNER reorder authority                                                                | MEMBER / selected Listing                                                | previous → final position; intermediate temporary positions are implementation details                               | provider.listing.order_changed                                               | unchanged position is a no-op; active                                   |
| rentListing / PATCH rent                                    | protected listing scope and listing lock                                                                                          | MEMBER / Listing and affected Applications                               | PUBLISHED/PAUSED → RENTED; selected ACTIVE → ACCEPTED; other ACTIVE/WAITING → REJECTED; ApplicationActivity retained | provider.listing.rented, application.tenant_selected and actual rejections   | no durable rental receipt; repeated command conflicts; active           |
| ApplicationLifecycleService.apply / applicant apply         | ApplicantListingAccess.admit; current session, public admission route, profile eligibility, listing lock                          | USER / new owned Application                                             | absent → ACTIVE or WAITING; APPLICATION_SUBMITTED and eligibility assessment                                         | application.submitted, one submission fact                                   | duplicate/cooldown conflict, not receipt replay; active                 |
| withdraw / applicant withdraw                               | ApplicantListingAccess.mutateApplication; owned resource and current session                                                      | USER / owned Application                                                 | ACTIVE/WAITING → WITHDRAWN; activity and viewing closure retained                                                    | application.withdrawn                                                        | WITHDRAWN replay is a no-op; active                                     |
| ProviderApplicationCurationService.reject                   | ProviderListingAccess.mutateApplication; scope, application.reject and cooldown                                                   | MEMBER / Application                                                     | ACTIVE → REJECTED; ApplicationActivity + ListingEvent retained                                                       | application.rejected                                                         | non-idempotent conflict/cooldown; active                                |
| ProviderApplicationCurationService.restore                  | same; application.restore, eligibility, latest-attempt and capacity rules                                                         | MEMBER / Application                                                     | REJECTED → ACTIVE or WAITING; activity, ListingEvent and assessment retained                                         | application.restored                                                         | no receipt; active                                                      |
| apply/reject/withdraw/resume/restore queue side effects     | caller's existing listing-root transaction and queue rules                                                                        | SYSTEM consequence / promoted Application                                | WAITING → ACTIVE; APPLICATION_PROMOTED_TO_ACTIVE and assessment                                                      | application.promoted; explicit queue-reconciliation purpose                  | only actual changes; active                                             |
| profile revalidation                                        | ProfileRevalidationTransactions; authenticated applicant session, sorted workspace/listing locks, one cross-workspace transaction | SYSTEM consequence / affected Applications; initiating USER authenticates the private profile scope | ACTIVE/WAITING → REJECTED; SYSTEM activity + assessment; may promote other applicants                                | application.rejected and actual promotions with closed purposes              | no independent tenant switch/commit; active                             |
| ViewingWorkflowExpiryService.processTarget, interest expiry | existing bounded expiry route; workspace, listing then application locks                                                          | SYSTEM / expired Application                                             | ACTIVE → REJECTED; deadline/workflow proof, SYSTEM activities and promotion                                          | application.rejected with viewing-interest-expiry purpose; actual promotions | stale target is no-op; active worker                                    |
| viewing interest decline / outcome withdrawal               | existing viewing command transaction; Applicant resource authority                                                                | USER / Application                                                       | actual withdrawal via withdrawWithinTransaction                                                                      | same application.withdrawn; preserve viewing receipt                         | receipt replay must not append again; active                            |
| provider post-viewing DO_NOT_CONTINUE                       | existing viewing decision transaction; provider authority                                                                         | MEMBER / Application                                                     | actual rejection through rejectWithinTransaction                                                                     | same application.rejected; preserve viewing receipt                          | receipt replay must not append again; active                            |

No new ownership transfer, unretire/reactivation, destructive deletion,
shortlist/preselection state or generic application status endpoint is invented.
The standalone promoteWaitingApplications service method has no current HTTP or
production caller; its existence does not activate a new endpoint. Queue consequences
of the listed active commands must still be covered. Assignment mutations remain Slice 3. Document verification revisions, viewing-only
states/outcomes, media synchronization and read-model invalidations are not
automatically duplicated as application/listing lifecycle Audit.

## Existing guarantees and debt

- AuditEvent, ApplicationActivity, ListingEvent, outbox and notifications remain
  separate. Audit adoption must not require one event per activity.
- Rental closing is currently atomic in its protected transaction, but has no
  durable rental-command receipt or dedicated rental-decision aggregate. Audit
  must describe that accurately rather than introduce a hidden redesign.
- Current public projection is populated only for PUBLISHED listings. RENTED
  rows are deleted by refresh_public_listing_projection; the older discovery
  concern must not be assumed still present on current main.
- No new OWNER/AGENT authority, applicant data projection or Audit feed is added.
  Application events must not expose WAITING-only resource identity through the
  existing internal OWNER reader merely because a new action exists.

## Approved execution boundary

Current Audit context creation, append and close require one ordinary tenant.
ProfileRevalidationTransactions deliberately installs none and cannot switch it:
its existing helper restores app.profile_revalidation_user before returning the
locked eligibility rows. Calling the ordinary Audit helpers there fails closed.
Splitting the profile transaction or installing tenant scopes would change its
approved atomic multi-workspace behavior.

Queue promotion, profile rejection and viewing-interest expiry also use SYSTEM
activity today. The current Audit SYSTEM opener allows only ledger activation
and is not executable by the ordinary application runtime. A human actor must
not be substituted for those system consequences.

The bounded extension was explicitly approved for Slice 4:

1. Keep normal MEMBER/USER Audit execution and tenant rules unchanged.
2. Define three closed purposes: queue reconciliation, profile eligibility
   revalidation, and viewing-interest expiry. Bind exact canonical effect/resource
   evidence; no free-form SYSTEM action, workspace or resource selector.
3. Add a dedicated profile-audit adapter within the existing outer transaction,
   bound to its authenticated applicant/session and exact locked workspace/listing
   set. It must handle both that applicant's rejection and permitted queue
   consequences without granting ordinary cross-workspace Audit access.
4. Preserve sorted authority/root locks; do not add an audit head lock, detached
   transaction, workspace switching, BYPASSRLS or broad role membership.
5. Validate denied foreign resources, forged purposes, stale sessions, ordinary
   tenant isolation, partial append rollback across workspaces, queue fairness,
   expiry races and original cleanup guarantees with restricted PostgreSQL tests.

This is an extension of the security execution seam, not merely new action names.
The implementation keeps these adapters within the original transaction and does not activate any dormant workflow.


## Implementation contract

The domain-owned adapters use the existing authorized, locked transaction.
ApplicationActivities and actual Application status transitions have private,
full-top-level-xid provenance. Deferred cleanup removes that technical proof at
commit; rollback removes it transactionally. These tables are not business
history, current authority, an epoch, or a replacement for domain receipts.
Released savepoints retain outer-transaction provenance without xmin assumptions.

The closed SYSTEM opener derives its workspace, actor purpose and resources from
new canonical activity plus a matching actual status transition. Queue promotion
may reuse an existing eligibility assessment. Profile scope is minted from the
applicant session and the exact existing locked listing/workspace set; ordinary
tenant scopes still cannot switch workspaces. Expiry requires the existing expired
interest/deadline evidence. Runtime cannot read/write the private proof tables.

Provider consideration without rejection records one
`application.consideration_recorded` fact with the canonical decision,
workflowId and workflowRevision. DO_NOT_CONTINUE records its actual rejection,
not a duplicate consideration fact. Other viewing-only activities remain outside
this slice. Receipt replay produces no new source activity or lifecycle Audit.

Payload schema version is 1. Listing actions carry only lifecycle states,
revisions, meaningful changed field names, positions for explicit ordering, and
the selected application ID for rental. Application actions carry resource
references and states or the bounded consideration decision. No field values,
profiles, documents, messages, financial values, sessions or tokens are copied.
Application USER snapshots use the generic label Applicant plus stable actor ID.
Existing OWNER Audit queries exclude applicant-only activity evidence.

Listing creation retains its INITIAL assignment receipt and separate Slice 3
assignment fact. Other server-generated command IDs are stable across transaction
retries but do not introduce HTTP idempotency. A required append failure rolls
back the entire domain transaction, histories, receipts and outbox. No asynchronous
post-commit append is used.

The forward migrations add four private technical models and closed helper/payload
extensions; prior migrations are unchanged. FORCE RLS, append-only protection and
restricted runtime checks remain mandatory. No new role membership or BYPASSRLS
is introduced. Existing tenant selection remains atomic and non-idempotent after
success (409 on replay); durable rental decision receipts remain explicit debt.

## Ordering revision contract

Manual reordering records previous/final display positions while preserving the
Listing revision: display_order is deliberately excluded from that domain epoch.
Other meaningful listing mutations require an advanced Listing revision. The
ordering correction is additive and does not change the Listing revision guard.

## Validation isolation

E2E runs sharing renyqo_e2e must execute sequentially: the existing shared
cleanup may terminate other connections in that database, even when schemas
are distinct. CI shards retain separate PostgreSQL containers. No cleanup or
listener guarantees are weakened by this slice.

The SYSTEM opener additionally validates the exact allowed action/status pair
for each purpose; a real but unrelated status mutation is insufficient.

## Consolidated deployment

Only this unmerged slice was consolidated. Migrations already merged in Slices
1–3 are unchanged. The four forward transactions are:

| Migration | Responsibility |
| --- | --- |
| 20261121130000_audit_lifecycle_contracts | Action/payload catalog and command scopes |
| 20261121131000_audit_lifecycle_execution | Private proof tables, execution scopes, RLS, closure and insert guards |
| 20261121132000_audit_lifecycle_evidence | Application, Listing and closed SYSTEM evidence helpers |
| 20261121133000_audit_lifecycle_access | Controlled append, internal query boundary and applicant actor privacy |

Ordering revision semantics and exact SYSTEM transition policies are defined once,
in their final form. There are no follow-up corrections to objects introduced by
this slice. The old 17-migration endpoint and the consolidated endpoint were
compared using the canonical catalog queries: tables/columns, constraints,
indexes, triggers, policies, function definitions/owners/grants, enums and schema
grants match. Fresh deployment and a populated upgrade from merged main both
produce zero Prisma drift. Existing local databases containing the discarded
unmerged migration history should use a fresh disposable test schema; production
has no such history. No migration-history records are rewritten by this slice.

## Narrow domain execution boundaries

`listing-audit-boundary.ts` handles only Listing snapshots and required append.
It performs no Application queries. `application-audit-boundary.ts` owns only
Application completeness/evidence checks. Neither opens a transaction or acquires
additional authority/root locks; both join the existing authorized transaction.

The provider adapter coordinates both only for explicit rental closing and
publication/resume consequences. Listing field edits, pause, draft, retirement,
ordering, media, assignment, documents and conversations do not run Application
Audit scans. Existing business queries and their own domain evidence remain.

Applicant admission and withdrawal, provider rejection/restoration, profile
revalidation, viewing-interest expiry and workflow commands retain Application
evidence. Workflow commands can process an interest expiry before their own action,
so they must not opt out. Legacy interest withdrawal opts in from its actual
NOT_INTERESTED decision; legacy cancellation and interest confirmation do not.
Proposal-only expiry does not enter Application lifecycle Audit.

## Technical machinery review

The four private tables retain distinct correctness responsibilities:

- audit_profile_scopes: authenticated applicant and exact locked resource set.
- audit_profile_bindings: binds an Audit execution to that cross-workspace proof.
- audit_activity_sources: proves new activity provenance in the full outer xid.
- audit_application_changes: proves the corresponding real old/new status change.

Five triggers remain: two provenance captures, two deferred provenance cleanups,
and the deferred unclosed-profile-scope guard. None emits business Audit or
replaces a state machine. No required SQL helper is duplicated or removed.
Inlining profile bindings into the established execution table would require a
wider context-layout rewrite without removing a security responsibility; that
change is outside this cleanup. No generic SYSTEM or tenant-switching authority
is introduced.

## Regression fixture preparation

The eligibility-parity case in profile-prequalification prepares six Listings
under one workspace. Its former Promise.all setup could exhaust the existing
bounded Serializable retries before entering Audit. Those six fixtures are now
prepared sequentially; scenarios and assertions are unchanged. Dedicated lock,
race and concurrency tests remain concurrent. No production retry, timeout,
sleep or isolation setting was changed.

## Slice 4 changed-file manifest

- `docs/audit-listing-application-adoption.md`
- `prisma/migrations/20261121130000_audit_lifecycle_contracts/migration.sql`
- `prisma/migrations/20261121131000_audit_lifecycle_execution/migration.sql`
- `prisma/migrations/20261121132000_audit_lifecycle_evidence/migration.sql`
- `prisma/migrations/20261121133000_audit_lifecycle_access/migration.sql`
- `prisma/schema.prisma`
- `src/applicant-profile/profile-revalidation-audit.ts`
- `src/applicant-profile/profile-revalidation-transactions.ts`
- `src/application-viewings/application-viewing-outcome.service.ts`
- `src/application-viewings/viewing-expiry-target.ts`
- `src/application-viewings/viewing-workflow-expiry.service.ts`
- `src/applications/application-audit-boundary.ts`
- `src/applications/application-audit-operations.spec.ts`
- `src/applications/application-audit-operations.ts`
- `src/applications/application-audit-state.ts`
- `src/applications/application-lifecycle-audit.ts`
- `src/applications/application-lifecycle.service.ts`
- `src/audit/context/lifecycle-append.ts`
- `src/audit/context/required-audit.ts`
- `src/audit/domain/audit-action.ts`
- `src/audit/domain/domain-evidence.ts`
- `src/audit/domain/lifecycle-action.ts`
- `src/audit/payload/lifecycle-effect.spec.ts`
- `src/audit/payload/lifecycle-effect.ts`
- `src/audit/persistence/audit-runtime-verifier.ts`
- `src/listings/applicant-listing-access.ts`
- `src/listings/application-audit-routing.spec.ts`
- `src/listings/application-listing-access.ts`
- `src/listings/listing-audit-boundary.spec.ts`
- `src/listings/listing-audit-boundary.ts`
- `src/listings/listing-creation.ts`
- `src/listings/listing-lifecycle-audit.ts`
- `src/listings/listing-ordering.service.spec.ts`
- `src/listings/listing-ordering.service.ts`
- `src/listings/listings.service.ts`
- `src/provider-authorization/adapters/provider-lifecycle-audit.spec.ts`
- `src/provider-authorization/adapters/provider-lifecycle-audit.ts`
- `src/provider-authorization/provider-listing-access.ts`
- `test/audit-lifecycle-applications.e2e-spec.ts`
- `test/audit-lifecycle-commands.e2e-spec.ts`
- `test/audit-lifecycle-concurrency.e2e-spec.ts`
- `test/audit-lifecycle-listings.e2e-spec.ts`
- `test/audit-lifecycle-migration.e2e-spec.ts`
- `test/audit-lifecycle-profile.e2e-spec.ts`
- `test/audit-lifecycle-security.e2e-spec.ts`
- `test/audit-lifecycle-system.e2e-spec.ts`
- `test/audit-lifecycle.fixture.ts`
- `test/audit-migrations.fixture.ts`
- `test/e2e-suite-hooks.ts`
- `test/listing-workspace.fixture.ts`
- `test/profile-prequalification.e2e-spec.ts`
- `test/workspace-entitlements-http.e2e-spec.ts`
