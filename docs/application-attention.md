# Application attention

## Diff scope review

The final phase diff contains 32 files: nine attention-domain files (A), seventeen shared-domain policy/read-projection files (B), and six API/documentation/test integration files (C). Two unused HTTP-module imports were reverted (D): application-conversation.module.ts and application-documents.module.ts. The read modules remain required by attention, but those existing HTTP modules do not consume their read providers.

All existing HTTP contracts, status codes, authorization outcomes, transaction isolation/locks and domain ordering remain unchanged. New read services add attention projections only. The nine A files are application-attention.module.ts, application-attention-query.service.ts, application-pending-action.service.ts, application-pending-action.service.spec.ts, application-pending-action.ts, provider-attention.controller.ts, applicant-attention.controller.ts, dto/attention-input.dto.ts and dto/attention-response.dto.ts, all under src/application-attention.

| Changed file outside attention | Class | Concrete purpose | Existing runtime behavior / smaller alternative |
| --- | --- | --- | --- |
| README.md | C | Discoverability of the five new attention APIs and documentation | Documentation only; no unrelated text changed |
| docs/api.md | C | Exact route, count and pagination contracts | Documentation only |
| docs/application-attention.md | C | Audience/privacy, action targets, ordering, batching and this scope audit | Documentation only; separate feature reference keeps README concise |
| src/app.module.ts | C | Register ApplicationAttentionModule | Adds the five approved GET routes; existing registrations retained |
| src/application-conversation/application-conversation.policy.ts | B | Own incoming-unread filtering and expected responder/read-only derivation | Extracted existing predicates; a separate policy avoids importing mutation services |
| src/application-conversation/application-conversation-read.service.ts | B | Group incoming unread counts and project latest sender/date by sequence without message bodies | New read projection only; invoking existing summaries per application would cause repeated queries |
| src/application-conversation/application-conversation-read.module.ts | B | Export only the conversation read provider to attention | New dependency wiring only; importing the HTTP module would pull mutation dependencies |
| src/application-conversation/application-conversation.service.ts | B | Call extracted responder policy and shared provider visibility predicate | Same unopened-provider initiation, turn-taking, ownership and terminal sending behavior |
| src/application-conversation/application-message.service.ts | B | Use one incoming-unread predicate for summary counts and sequence-bounded acknowledgement | Same selected/updated rows; duplicated predicates removed |
| src/application-documents/application-document.policy.ts | B | Own FAILED-never-available retry and AVAILABLE-unreviewed/current-request capabilities | Existing upload/review/supersession predicates extracted; no state transitions added |
| src/application-documents/application-document-read.service.ts | B | Select current non-superseded requests and minimal current-file facts | New read projection only; existing request lists load upload history unnecessarily for attention |
| src/application-documents/application-document-read.module.ts | B | Export only the document read provider | New wiring only; avoids storage/queue/mutation providers |
| src/application-documents/application-document-access.service.ts | B | Delegate mutation eligibility and provider visibility to application-owned policy | Same ownership checks, 404/409 outcomes and locks |
| src/application-documents/application-document-request.service.ts | B | Share upload/review predicates with attention while retaining request DTO mapping | Same statuses, history, replacement capability and response fields |
| src/application-documents/application-document.service.ts | B | Use the same upload retry predicate in authorization and actual upload | Same rejection rule, storage/processing/download/review/transaction behavior |
| src/application-viewings/application-viewing-read.service.ts | B | Project latest round plus all completed rounds awaiting interest; call existing nextAction | New read projection only; calling paginated viewing APIs would miss older obligations |
| src/application-viewings/application-viewing-read.module.ts | B | Share read provider, existing policy and clock without exporting mutation services | Dependency ownership changes only; one clock/policy registration shared by both consumers |
| src/application-viewings/application-viewing-access.service.ts | B | Delegate mutation eligibility and visible-state check to application-owned policy | Same ownership, WAITING exclusion, lifecycle and locking behavior |
| src/application-viewings/application-viewing.policy.ts | B | Narrow nextAction input to fields it actually reads | Type-only change; implementation and timing boundaries identical |
| src/application-viewings/application-viewings.module.ts | B | Import policy/clock from read module instead of registering duplicate instances | Existing viewing services receive the same providers; this import is consumed |
| src/applications/application-process.policy.ts | B | Own actionable-state predicate and one provider visibility definition for row/SQL evaluation | No lifecycle engine or mutations; ownership remains explicit in callers |
| test/application-attention.e2e-spec.ts | C | New APIs, privacy, counts, snapshot, ordering, timing, batching and original-domain visibility parity | Test-only; actual SQL instrumentation and 201-application coverage |
| test/application-documents.e2e-spec.ts | C | Confirm revoked previously available file still forbids retry and retains one history row | Focused existing-upload regression; no fixture/framework rewrite |

The two reverted files are the only unnecessary changes identified. Remaining read modules intentionally keep Nest dependency boundaries separate; combining them into attention would move domain-owned projections out of their domains. Provider status/history visibility is defined once and used by conversation, document, viewing and attention paths; SQL and row predicates share the same allowed/hidden status sets.

Attention is derived from current conversation, document, viewing and application state. Nothing is persisted for badges or pending actions. Domain policies remain the authority; ApplicationActivity remains audit history. No primary action or urgency score is calculated.

## API

All routes are under /api/v1 and require authenticated, active users with the matching audience role.

| Method | Route | Response |
| --- | --- | --- |
| GET | /provider/applications/:applicationId/attention | Application attention detail |
| GET | /applicant/applications/:applicationId/attention | Application attention detail |
| GET | /provider/attention | Provider totals, listing totals and application summary page |
| GET | /provider/listings/:listingId/attention | Owned listing totals and application summary page |
| GET | /applicant/attention | Applicant totals, listing totals and application summary page |

Aggregate query inputs are offset (default 0, minimum 0, maximum 1000000) and limit (default 20, range 1–100). UUID parameters must be UUID v4. Unknown inputs are rejected. Application pages sort by application ID ascending, independently of badge totals. Listing totals sort by listing ID ascending. Provider results include owned listings with zero attention. Applicant results include only listings represented by their own applications.

## Actions and targets

| Action | Audience | Source | Target |
| --- | --- | --- | --- |
| RESPOND_TO_MESSAGE | Expected responder | CONVERSATION | Application context; no conversation/message ID |
| UPLOAD_REQUESTED_DOCUMENT | Applicant | DOCUMENT | requestId |
| REVIEW_DOCUMENT | Provider | DOCUMENT | requestId and documentId |
| RESPOND_TO_VIEWING | Applicant | VIEWING | viewingId |
| RESPOND_TO_VIEWING_CHANGE_REQUEST | Provider | VIEWING | viewingId |
| CLOSE_UNANSWERED_VIEWING | Provider | VIEWING | viewingId |
| RECORD_VIEWING_OUTCOME | Provider | VIEWING | viewingId |
| CONFIRM_POST_VIEWING_INTEREST | Applicant | VIEWING | viewingId |

These targets are existing public API resource identifiers. Internal storage keys, hashes, outcome-decision IDs, message bodies, profile fields and activity payloads are not loaded or exposed. Multiple resources can contribute multiple actions of the same type. Optional capabilities such as opening a conversation or proposing a viewing do not create obligations. Provider acknowledgement of post-viewing interest is not supported and produces no action.

## Unread and lifecycle

Application detail exposes historicalUnreadMessageCount and actionableUnreadMessageCount. Historical unread counts incoming messages with readAt null, using the conversation domain's predicate. Sequence-based acknowledgement remains unchanged. Reply responsibility follows the latest message sequence, independent of whether that message was read. An unopened conversation creates no reply action.

Actionable unread is historical unread only while the application is ACTIVE and its listing is PUBLISHED or PAUSED; otherwise it is zero. Operational aggregate totals and compact application summaries expose only actionableUnreadMessageCount. Historical unread is available in detail for reading/acknowledgement and never becomes a terminal-process badge.

WAITING applications are excluded from provider scope before domain reads. Other provider-visible applications must be ACTIVE or have activeAt history, and belong to an owned listing. Applicant reads are restricted to their own applications. REJECTED, WITHDRAWN, ACCEPTED and WAITING applications and DRAFT, ARCHIVED and RENTED listings have no actionable mutations. Ownership/hidden-resource failures return 404.

## Domain derivation

Conversation policy owns expectedResponder and read-only state. Document policy owns upload eligibility, retry eligibility, current-file review and supersession. PROCESSING files produce no upload/review action; retries require FAILED with no historical availableAt. Only current non-superseded requests contribute actions. Reviewed files disappear from review attention.

Viewing policy owns nextAction and timing. Future proposals require applicant response; unanswered proposals at startsAt require provider closure. Accepted viewings require outcome recording at endsAt. Latest time changes require provider response. Every effectively completed round without interest remains eligible for applicant interest, including historical rounds alongside a newer proposal.

## Counts, ordering and consistency

pendingActionCount equals the deduplicated resource-obligation count and hasPendingAction equals pendingActionCount greater than zero. applicationsWithPendingActions counts distinct applications with actions. totalPendingActions sums their obligation counts. actionableUnreadMessageCount sums incoming actionable unread messages. Unread messages are never added to pendingActionCount.

Totals cover the full authorized scope, not the returned application page. All data is read in one Repeatable Read transaction with one captured asOf. The same snapshot, audience and asOf produce the same result; time-sensitive viewing state can change without a database write.

Actions sort by oldest obligation timestamp, then action type in code-point order, then public target ID. The internal timestamp is latest incoming message createdAt for reply responsibility, requestedAt for upload, availableAt for review, createdAt for proposal response, changeRequestedAt for requested changes, startsAt for unanswered closure, endsAt for recording outcome, and the effective completed decision's recordedAt for interest. pendingSince is not exposed. Deduplication uses audience, application, action type and target.

## Query boundaries and reuse

ApplicationAttentionQueryService exports authorized batch enrichment for future endpoint integration. Existing list endpoints retain their current response shapes in this phase. Aggregate reads process batches of at most 200 applications, loading grouped unread counts, latest messages by sequence, current document pointers, latest viewing rounds and completed rounds awaiting interest. PostgreSQL DISTINCT ON is used only for minimal latest-message projection. Prisma grouping and selections handle other reads. No activity scans, complete message history, caching or materialized state are introduced.

Aggregate query count grows by application batches, not by individual applications. The PostgreSQL-backed performance test instruments Client queries for one versus 25 applications with conversations, documents and viewings. It also verifies that attention SELECT statements do not load message bodies, activity history, storage keys or password hashes.

## Validation

Focused units cover composition, audience mapping, duplicate elimination, stable ordering, DTO validation, document capabilities and the application/listing lifecycle matrix. Dedicated PostgreSQL E2E covers the five APIs, authorization, WAITING privacy, actual domain mutations, replacements, historical viewing interest, exact totals across pages, batch/detail equivalence, timing boundaries and concurrent snapshot consistency.

Run npm run test -- --runInBand application-attention application-conversation application-viewings application-message and npm run test:e2e -- --runTestsByPath test/application-attention.e2e-spec.ts. E2E requires the dedicated renyqo_e2e URL and E2E_DATABASE_ALLOW_RESET=true; cleanup is guarded and includes protected viewing audit tables through coordinated truncation.
