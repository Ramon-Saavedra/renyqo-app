# Viewing workflow commands (Phase 3)

> This page records its implementation phase. Phases 1–9 are complete; see [current rollout and schema](viewing-workflow-rollout.md) for deployment status and follow-ups.

Phase 4 now supplies lifecycle closure, restore protection, outcome/interest/consideration commands and worker-ready timeout rejection. See [Viewing lifecycle integration](viewing-workflow-lifecycle.md) for the extensions and remaining rollout limits; statements below about deferred Phase 4 behavior describe the original Phase 3 boundary.

This phase supplies command persistence, concurrency and explicit legacy reconciliation. It does not enable a complete product rollout: lifecycle closure, modern outcome/interest operations, application priority, attention/read models, expiry worker, realtime and durable notifications still require their approved phases.

## HTTP contract

Base paths: `/api/v1/provider/applications/:applicationId/viewing-workflow` and `/api/v1/applicant/applications/:applicationId/viewing-workflow`. Existing role, ownership, WAITING visibility and application/listing mutation rules apply. Unauthorized/hidden applications return 404. All commands are POST and return 200 on success.

Every command requires `requestKey` (UUIDv4, application-scoped idempotency key) and `expectedWorkflowRevision` (JSON integer). Path targets are UUIDv4. Unknown fields, numeric-string revisions, string booleans and offset-free datetimes are rejected.

| Audience  | Relative path                              | Additional input                                                                 |
| --------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Both      | GET root                                   | none                                                                             |
| Both      | `/reconcile`                               | none                                                                             |
| Provider  | `/invitations`                             | schedule                                                                         |
| Provider  | `/proposals/:proposalId/accept`            | none                                                                             |
| Provider  | `/proposals/:proposalId/reject`            | none                                                                             |
| Provider  | `/proposals/:proposalId/counterproposal`   | schedule                                                                         |
| Provider  | `/appointments/:appointmentId/replacement` | schedule                                                                         |
| Provider  | `/:workflowId/close`                       | `reason`, explicit nullable `proposalId` and `appointmentId`, optional `message` |
| Applicant | `/proposals/:proposalId/accept`            | none                                                                             |
| Applicant | `/proposals/:proposalId/reject`            | none                                                                             |
| Applicant | `/proposals/:proposalId/alternative`       | schedule                                                                         |
| Applicant | `/proposals/:proposalId/withdraw`          | none                                                                             |
| Applicant | `/appointments/:appointmentId/alternative` | schedule                                                                         |
| Applicant | `/appointments/:appointmentId/cancel`      | optional `message`                                                               |

Schedule: `startsAt`, `endsAt` as explicit-offset ISO instants; `timeZone` as IANA timezone; optional shared `message` (1–500 characters), optional boolean `shortNotice` (default false). Instants are canonicalized to UTC for persistence/retries. The existing schedule policy validates timezone/offset agreement and 5–240 elapsed-minute duration. An applicant alternative must differ from the targeted provider invitation and the confirmed appointment, when present.

Provider counterproposal atomically declines an applicant proposal and opens a provider proposal. It can also supersede/reissue the provider's own pending invitation. Replacement/alternative against an appointment requires no other pending proposal; target an existing pending proposal to continue negotiation. Provider close reasons are `PROVIDER_ILLNESS`, `PROVIDER_OPERATIONAL`, `PROPERTY_UNAVAILABLE` or `OTHER`; cancellation is attributed to the provider. Applicant cancellation uses `APPLICANT_CANCELLED`, records a late flag at/inside six hours, and never rejects/withdraws the application. Both cancellation operations close any pending replacement. A provider can initiate a new invitation after closure; old proposals/appointments remain terminal.

Success response: `{ applicationId, workflowId, workflowRevision, proposalId, appointmentId }`. IDs identify the affected command targets/results; nullable fields are not an authoritative pointer snapshot. Always GET again after a mutation or replay. GET provides mode (`EMPTY`, `LEGACY`, `CURRENT`), revision, reconciliation requirement, mutation blocker, pending proposal with exact targets/deadline/message, confirmed schedule and `asOf`. LEGACY pointers are deliberately hidden. This is a minimal command snapshot, not the future attention/capability/history contract.

State conflicts return HTTP 409 with `{ statusCode: 409, code: "VIEWING_STATE_CHANGED", applicationId, reason, currentWorkflowRevision }`. Reasons distinguish stale revision, noncurrent targets, inactive process, cutoff, expired offer, legacy reconciliation/reissue requirements and unavailable actions. Refresh and reconfirm intent with a new key; never automatically retarget an old command. Different payload/actor reusing an existing key returns `VIEWING_IDEMPOTENCY_KEY_REUSED`. Validation errors return 400, including `VIEWING_SHORT_NOTICE_REQUIRED` for implicit short notice.

## Transactions and deadlines

Each command uses Serializable retries and the existing listing → application lock order, reauthorizes under locks, then checks durable receipts, mutation eligibility, expected revision and exact target. Receipt replay requires authorization but intentionally precedes current mutation eligibility: a successful old command can be replayed after application termination. It returns the original result/revision, without modifying current state. The hash includes side, action, expected revision, exact IDs and canonical input. Receipt, activities, proposal resolution, ledger/appointment changes and one revision increment commit together. Failed validation rolls back everything.

Normal provider invitations require at least 18 elapsed hours of lead time and the full 12-hour response window. Response deadline is bounded by now + 12h, the proposed start and the existing confirmed start. Provider proposals with less lead or a shorter available window require explicit `shortNotice: true`. Applicant alternatives use the same bounded deadline and are marked short notice if that window is shortened. Applicant reschedule requests stop exactly six elapsed hours before the confirmed start. Existing appointments remain valid throughout negotiation, and rejection/withdrawal/expiry only clear the pending offer. Acceptance first supersedes the prior ledger commitment, then creates the accepted appointment and swaps pointers in the same transaction; deferred constraints prevent contradictory committed states.

Acceptance is strictly before the stored deadline. The first correctly targeted, current-revision command encountering an expired pending offer records SYSTEM expiry/history, clears the pending pointer and increments revision, then commits a durable **409** receipt. The requested action is not executed. A retry returns that same error even after a later invitation. Other competing commands see the new revision. A stale exact target cannot trigger expiry of its successor. This is enforcement at command time, not the deferred expiry worker; an offline expired proposal can remain stored pending until a command or later worker processes it. GET reports it as expired immediately. Cancellation/closure encountering expiry may therefore need a refreshed revision and new request key.

Appointment cancellation/replacement/acceptance requires a future commitment. At/after its start, attendance/outcome resolution belongs to the later decision phase; commands do not silently cancel an appointment already underway. No availability calendar, cross-application/provider overlap lock or timezone-local recurrence is introduced.

## LEGACY → CURRENT cutover

No new command trusts an imported snapshot. Non-reconciliation commands return `LEGACY_RECONCILIATION_REQUIRED`, including when legacy ledger history exists but no workflow snapshot was imported. The explicit reconcile endpoint requires a key and the snapshot revision. In the same authorized Serializable transaction, the SQL function reacquires listing/application locks, reconciles all actual rounds plus accepted appointments and existing interest summaries, validates the complete projection, then switches to CURRENT and increments revision. CURRENT reconciliation is a harmless receipt-backed no-op. Empty applications remain empty until a provider initiates.

Imported proposal insertion/update is permitted only while LEGACY and only when the entire row exactly matches `legacy_viewing_proposal_rows`, derived from the actual ledger and evidenced activity links. No session flag or disabled trigger bypass is used. Unverifiable history fails closed. A forward hardening migration resolves PL/pgSQL record/table alias ambiguity in the reconciliation function; both migrations are required. Neither changes the Phase 2 import migration.

IDs, existing outcome revisions, activities, text-only change-request data and unknown historical actors are retained. Missing deadlines/alternatives/absence attribution are never invented. Accepted timestamps preserve source acceptance even when an appointment later completed/cancelled. Undated legacy invitations may be rejected or explicitly reissued, but cannot be newly accepted with an invented historical response window. Reissue/counterproposal retires the legacy unresolved ledger placeholder only when that actual new action occurs.

Old proposal/respond/cancel/outcome/interest mutation handlers now reject CURRENT workflows with `WORKFLOW_COMMAND_REQUIRED` under the same locks. They remain unchanged for LEGACY applications. This prevents bypassing current pointers/revisions or writing unstructured no-show/interest data. Existing outcome correction history is preserved, but CURRENT outcome/correction commands must be connected in the later decision phase before rollout. Old reads still expose ledger-based projections; they do not yet expose every negotiated pending proposal.

## Rollout limits and remaining decisions

- Do not expose reconciliation/new commands to users before lifecycle, read-model, decision, realtime and durable notification work is complete. Process termination is not yet composed with CURRENT closure; restoration must not revive commitments in Phase 4.
- Six-hour restrictions govern applicant change requests, not late cancellation; applicant withdrawal of their own pending alternative remains possible before its response expiry. Short-notice invitations remain explicitly opt-in and may be declined.
- Provider close/reopen permits another invitation; no permanent viewing ban is implied. Application lifecycle remains the authority for eligibility.
- Phase 4 must define cancellation after appointment start, outcome correction effects on pending replacements/interest, and attendance attribution. Decide later whether overlap prevention/calendar availability or a negotiation-round/rate limit is needed.
- No outbox writes, realtime delivery, durable notification inbox, background expiry or ACTIVE priority changes are included here. Transactional history is preserved and safe target IDs are included for later deep links.

Tests cover boundary validation, authorization, rollback, duplicate/canonical retries, stale revisions and exact targets, all requested tab races, retained confirmations, cancellation attribution, and reconciliation races against both new commands and old ledger writers.
