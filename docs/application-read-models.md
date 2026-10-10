# Application read models

This phase adds read composition. Lifecycle, conversation, document, viewing and attention domains remain authoritative. No frontend changes, workflow redesign, persisted summaries, caches, materialized views or migrations are introduced.

## Endpoints

All routes below are authenticated GET requests under `/api/v1`. Provider and applicant role guards apply to their respective routes.

| Route                                                                        | Response                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/provider/listings/overview`                                                | Paginated compact listing selection with active, anonymous waiting, exited and operational attention counts |
| `/provider/listings/:listingId/application-overview`                         | Selected listing summary, full listing counts, up to five ACTIVE applicants and five recent exits           |
| `/provider/applications/:applicationId/workspace`                            | Provider workspace with compact applicant identity                                                          |
| `/applicant/applications/overview`                                           | Paginated application cards with compact listing identity and operational summaries                         |
| `/applicant/applications/:applicationId/workspace`                           | Applicant workspace with compact listing identity                                                           |
| `/{audience}/applications/:applicationId/activity`                           | Cursor-paginated audience-visible activity timeline                                                         |
| `/{audience}/applications/:applicationId/document-history`                   | Cursor-paginated document requests, including superseded requests, without embedded file history            |
| `/{audience}/applications/:applicationId/document-requests/:requestId/files` | Cursor-paginated safe file attempts for one authorized request                                              |

`{audience}` is `provider` or `applicant`. Static overview routes are registered before existing parameterized routes.

## Collection envelopes and ordering

Collections return `asOf`, `items`, `pagination { limit, hasMore, nextCursor }` and `totalCount`. Counts cover the authorized scope before the cursor boundary. Provider listing attention counts cover all visible applications belonging to each returned listing, not just its five-row previews.

Query parameters are `cursor` and `limit`. Default limit is 20; maximum is 100. Unknown input fields, malformed cursors and invalid page sizes return 400. Cursor data is an opaque encoded boundary, validated by collection kind, UUID and timestamp/order value. It cannot change authorization scope.

| Collection               | Order                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| Provider listings        | `displayOrder ASC, id ASC`                                                 |
| Applicant applications   | `createdAt DESC, id DESC`                                                  |
| Activity                 | `occurredAt DESC, id DESC`                                                 |
| Document request history | `requestedAt DESC, id DESC`                                                |
| File attempts            | `createdAt DESC, id DESC`                                                  |
| ACTIVE applicant preview | `activeAt ASC, id ASC`, maximum five                                       |
| Recent exit preview      | `COALESCE(rejectedAt, withdrawnAt) DESC NULLS LAST, id DESC`, maximum five |

Applicant ordering uses submission time. There is no applicant quality ranking. Each response has its own consistent snapshot; cursors do not freeze the database across subsequent requests. Moving listing positions or new records can affect later pages.

## Compact contracts

Listing identity contains `id`, `title`, `city`, `coldRent`, `status` and `imageUrl`. Applicant cards select one cover image, with fallback to the earliest position and an ID tie-breaker. They do not retrieve every image. Provider listing selection currently returns `imageUrl: null`, avoiding an unnecessary image read.

Provider applicant rows contain `applicationId`, `status`, `submittedAt`, `activeAt`, `exitedAt`, `publicReason`, `applicant { name, peopleCount, introduction }` and `attention { pendingActionCount, hasPendingAction, actionableUnreadMessageCount }`.

Applicant cards contain `applicationId`, `status`, `submittedAt`, `activeAt`, `listing`, compact `attention`, `conversation`, document counts and `viewing`. Conversation exposes `isOpen`, `isReadOnly`, `expectedResponder` and `canCurrentUserSend`; it contains no message preview. Document counts distinguish requested, upload-required, review-required, processing and reviewed requests. Action counts are audience-specific and become zero when the application process disallows those actions.

Viewing summaries expose current/latest/latest-completed viewing state, change-request state, pending interest, authoritative `nextAction`, `canPropose`, schedules, effective outcome, submitted interest and per-viewing capabilities. At most one row per summary category is serialized; full viewing history is separate. Outstanding interest obligations remain part of the authoritative attention derivation even for older completed rounds.

## Workspace contract

Workspace sections are `asOf`, `application`, `attention`, `conversationSummary`, `documentsSummary`, `viewingSummary`, `activityPreview`, `capabilities` and exactly one audience identity section: `applicant` for the provider or `listing` for the applicant.

`application` includes public lifecycle status and timestamps. `attention` contains the existing full pending-action DTOs, historical unread, actionable unread and the same response `asOf`. No new action enum or priority policy is introduced.

`documentsSummary` contains counts, `canRequestDocuments` and only current non-superseded request summaries: public request/type/label/status/document identity and download/upload/review/replacement permissions. No file attempts, content or storage metadata are embedded.

`activityPreview` contains the latest five safe audience-visible entries and `hasMore`. The domain public payload allowlist removes private reasons and internal actor/storage metadata.

Lifecycle capabilities expose `canWithdraw`, `canReject`, `canRestore` and `canSelectForRental`. They follow existing mutation semantics: withdrawal is permitted for ACTIVE/WAITING; rejection checks ACTIVE state and curation cooldown; restoration additionally requires NOT_SELECTED, a PUBLISHED listing and authoritative eligibility; rental selection follows ACTIVE plus PUBLISHED/PAUSED. Historical restoration can legitimately remain available. Capabilities describe the captured state; mutation endpoints still revalidate concurrently changing state and enforce their guards.

Applicant workspace capabilities additionally contain `admission { hasApplicationHistory, currentApplicationId, currentApplicationStatus, canSubmitApplication, submissionBlockReason, reapplyAvailableAt }` for the applicant/listing pair, using the same shared policy as submission. Historical workspaces can identify a newer current attempt without reopening their own row. Provider `canRestore` is false if a newer attempt exists; applicant re-submission cooldown does not disable otherwise valid provider restoration. Listing summary/detail responses expose the same admission DTO. Existing historical `hasApplied` does not imply submission is blocked. See [Application lifecycle](application-lifecycle.md) for rejection-specific re-submission rules.

## Heavy resources

Existing message, document-content and viewing-history endpoints remain separate. New activity, document-request history and file-attempt endpoints are independently bounded. Legacy unbounded document-request arrays remain for compatibility; new screens should use current workspace summaries plus the bounded history routes. No route is deprecated or removed in this phase.

## Privacy and compatibility

Provider identity reads require owned listings and the shared provider visibility rule: ACTIVE applications or non-WAITING applications that were previously active. WAITING and never-active exited applications are excluded from identity rows, attention, unread and domain-existence projections. The anonymous WAITING count is the only permitted exception and is scoped to owned listings.

Applicants read only their own applications. Unauthorized/hidden applications and foreign document requests return 404. Activity visibility filtering happens before pagination and counting. Terminal history remains readable under the existing audience rules, with operational capabilities disabled where domain rules require it.

No response exposes password hashes, internal actor IDs, storage keys/buckets/versions, security verdicts, private reasons, message bodies or idempotency/queue metadata. Public resource IDs are retained when needed to navigate or invoke existing APIs.

Legacy provider application arrays intentionally stop returning never-active exited identities. All other existing response envelopes and pagination contracts remain unchanged.

## Query boundaries

Every composite captures one clock value and uses one Repeatable Read transaction. Authorization, domain facts, previews and counts share that transaction. Internal attention composition consumes the same projections as workspace summaries and never starts an independent transaction. Lifecycle capabilities consume the already-authorized application; minimal eligibility facts are fetched only when restoration is otherwise possible.

List composition batches conversations, grouped unread counts, current document requests and selected viewing rows. Message bodies and full historical files/activity are excluded from compact selectors. Parameterized SQL is limited to existing/latest-message reads, one image per listing and deterministic recent-exit selection; Prisma handles the other reads.

Provider full-listing attention totals scan authorized application facts in batches of 200, retaining totals and requested preview summaries. Work therefore scales with batches, not one query per application. Queries per page are bounded within each batch, and complete derived application results are not retained for aggregation.

## Performance validation and indexes

PostgreSQL-backed tests instrument actual driver SELECTs at 1, 25 and 101 applications, independently of HTTP/session queries. Applicant overviews use 14 SELECTs and provider listing overviews use 16 at each tested size. Selected-listing/workspace/history instrumentation also checks fixed query groups and database LIMITs or primary-key-bounded current-file reads as history grows.

Representative EXPLAIN ANALYZE fixtures include 151 listings, 1001 applications and 1000 activity rows. Existing listing ordering and activity indexes support bounded preview reads. Applicant application ordering uses a small top-N sort at this tested scope. These measurements do not establish production-scale latency guarantees; no new index is justified by the current evidence. Reassess the applicant ordering query at materially larger real scopes.

## Validation commands

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npx prisma validate
npm test -- --runInBand application-read-models
npm run test:e2e -- --runTestsByPath test/application-read-models.e2e-spec.ts
npm test -- --runInBand
npm run test:e2e
npm run build
git diff --check
```

E2E tests require the dedicated local `renyqo_e2e` database and the repository's existing safety marker. Privacy, cursor, lifecycle agreement, projection contracts, query counts, snapshot consistency and legacy contract regressions are included in the read-model E2E suite.
