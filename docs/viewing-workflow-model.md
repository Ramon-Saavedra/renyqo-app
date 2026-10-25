# Viewing workflow model — Phase 2

> This page records its implementation phase. Phases 1–9 are complete; see [current rollout and schema](viewing-workflow-rollout.md) for deployment status and follow-ups.

This is an additive schema/migration phase. It introduces no commands, endpoints, realtime production, expiry worker or changed ACTIVE ordering behavior. Existing APIs continue to use the old contract until explicit cutover. The [roadmap](viewing-workflow-redesign.md) remains staged; durable notifications are a required later phase.

## Durable model

| Model                              | Authority after cutover                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ViewingWorkflow`                  | One per application; revision, provider initiation, pending proposal and confirmed appointment references, open/closed state with reason, provider consideration decision.                                              |
| `ViewingProposal`                  | Immutable schedule round, proposer/responder, shared message, predecessor proposal/base appointment, explicit normal/short-notice timing, deadline, resolution/actor/time and request-key/hash.                         |
| `ViewingAppointment`               | An accepted proposal linked one-to-one to its existing `ApplicationViewing` ledger row. Cancellation attribution/reason/shared note/late flag and applicant interest request state/deadline.                            |
| `ApplicationViewing`               | Existing appointment/history ledger, retaining its IDs, schedule, status/timestamps, outcomes and interest response. New unaccepted offers live only in proposals, not a second appointment store.                      |
| `ApplicationViewingOutcome`        | Existing append-only revisions/correction reasons, plus nullable `absenceSide` (`APPLICANT`, `PROVIDER`, `BOTH`). Null means historical/unknown, never an applicant penalty.                                            |
| `ApplicationConsiderationPosition` | Separate per-application/per-listing position for ACTIVE consideration. Sequence allocation and listing/position uniqueness. Independent of WAITING `queueOrder`, historical `activeAt`, profile/income and reputation. |

Appointment schedules remain physically in the old ledger to avoid relocating outcome/interest/activity links. A confirmed appointment's schedule must equal its accepted source proposal. This accepted snapshot duplication is constrained, not two independently editable schedules. New proposals can coexist with the confirmed reference without changing it. Acceptance/replacement will be a Phase 3 transaction that resolves the proposal, supersedes the previous ledger commitment and swaps the workflow pointers together.

## Migration and legacy mapping

Migration: `20261024120000_viewing_workflow_model`. DDL, backfill and constraints run in one transaction. It adds `POST_VIEWING_RESPONSE_EXPIRED` to `ApplicationRejectionReason`; no application is transitioned to it in this phase.

- Applications with viewings get one **LEGACY-mode cutover snapshot**, revision zero. Imported workflow ID equals application ID. Applications without viewings get no invented workflow.
- Each existing viewing produces one provider-to-applicant proposal with the **same viewing ID**, round, schedule, provider note, creation time and request key/hash.
- `acceptedAt` proves proposal acceptance even if the appointment was subsequently declined, changed, cancelled or superseded. Such rows get an appointment record with the same viewing ID. All outcome revisions and interest response IDs remain in their original tables unchanged.
- Otherwise: `PROPOSED` → pending; `DECLINED`/`CHANGE_REQUESTED` → declined original offer; `SUPERSEDED` → superseded; cancellation → closed. A text-only change request creates **no alternative appointment**. Its original text and timestamps stay on the ledger.
- Existing accepted status supplies the confirmed snapshot reference. Existing proposed status supplies the pending snapshot reference. No application lifecycle closure is fabricated during import.
- Only predecessor/base links explicitly evidenced by same-application, earlier-round activity metadata are recovered. No chain is guessed from neighboring round numbers.
- Imported timing is `LEGACY`, with **no response deadline**. Resolution actor and cancellation attribution remain unknown. Generic historical no-shows retain null absence attribution, including original revisions later corrected.
- Completed appointments without interest become `LEGACY_UNANSWERED`, with **no invented interest deadline**. Existing interest responses are copied into the appointment's summary state, without changing the response rows or inventing a request time.
- Existing ACTIVE display order (`activeAt ASC NULLS LAST, id`) is copied into consideration positions. No WAITING order, active status, five-slot capacity, or provider read ordering changes. Sequence allocation resumes above imported positions. Phase 5 must reconcile newly activated applications and begin using this order.

## Explicit cutover boundary

LEGACY snapshots are **not live projections**. Old commands may change the ledger after this migration and may create applications/rounds absent from the snapshot. New readers/commands must never treat LEGACY pointers or consideration positions as current authority.

Phase 3 now implements the explicit reconciliation boundary described below; see [Viewing workflow commands](viewing-workflow-commands.md). Its subsequent migrations permit LEGACY imports only when the entire proposal matches the canonical ledger source, and gate old writers after cutover. The runtime insertion prohibition below describes the Phase 2 baseline, before those guarded reconciliation functions.

Before switching an application to `CURRENT`, Phase 3/rollout must stop or gate legacy writers, acquire the existing listing/application locks, reconcile all old rounds/resolutions/outcomes/interest and references, then switch mode and increment revision in the same transaction. That privileged migration reconciliation must accommodate the immutable imported snapshot; it is not a normal proposal command. Validate the entire workflow before committing. Remove the legacy write path at cutover; do not maintain indefinite dual writes. No automatic mode switch or synchronization is installed in Phase 2. Runtime insertion of LEGACY workflows/proposals and downgrade from CURRENT are prohibited.

For CURRENT mode, old appointment writes without the proposal/appointment records fail consistency checks. This is intentional protection against accidentally running old mutation handlers after cutover. Do not enable CURRENT workflows for users until their command/read/lifecycle/notification phases are ready.

## Database invariants

- One workflow per application; nonnegative revision; meaningful workflow updates require the next revision. Commands must still implement expected-revision comparison under locks—this migration is not an HTTP concurrency contract.
- A provider initiates the first round. Applicant alternatives require an earlier provider invitation or base appointment. Predecessor/base rounds must be earlier, preventing cycles.
- Partial uniqueness allows one pending proposal. Composite foreign keys ensure pointers, predecessors and base/source references stay within the same workflow. Consideration positions cannot name a different application's listing.
- A CURRENT workflow's pending pointer must match exactly its pending proposal. Its confirmed pointer must match the accepted commitment. It cannot silently drop the confirmed reference while leaving that commitment accepted.
- An accepted offer has exactly one appointment, whose application and schedule match. The existing partial index continues preventing multiple unresolved ledger commitments per application.
- Proposal schedules, targets, timing, message and command identity are immutable; terminal resolutions cannot be rewritten. Appointment source identity and opened interest deadlines cannot be changed. Existing append-only outcome/interest protections remain intact.
- New proposals require a valid IANA timezone, 5–240 elapsed-minute duration, and a response deadline after creation, no later than the proposed start and at most 12 elapsed hours after creation. Normal provider invitations require at least 18 hours' lead time. Exact normal-window selection and the six-hour applicant cutoff belong to Phase 3 policy.
- Only the intended responder can accept/decline; acceptance is strictly before the stored deadline. Expiry is attributed to SYSTEM at/after the deadline; withdrawal is attributed to the proposer.
- New cancellation requires actor and structured reason. Current non-legacy no-show decisions require explicit absence attribution. A completed current appointment requires an interest request/decision state; pending interest requires an exact 48-elapsed-hour window. Response summary must match its immutable response row.
- `DO_NOT_CONTINUE` requires real `REJECTED`/`NOT_SELECTED` application state in the same transaction. It cannot be persisted as a decorative decision.
- Cross-row invariants use deferred constraint triggers to permit atomic pointer/decision swaps. Proposal and appointment-metadata writes version-lock the workflow without altering its revision, rejecting stale RepeatableRead/Serializable snapshots. Expected revision, public authorization, six-hour cutoff, lifecycle closure, priority consequences, expiry transitions and outbox delivery remain future command/orchestration responsibilities.

## Review and rollout risks

- This migration takes ordinary DDL/backfill locks and creates indexes transactionally; schedule production deployment according to table size. It is not a zero-lock migration. Existing data is preserved and the transaction rolls back on failure.
- LEGACY mode and its absent deadlines are deliberate compatibility exceptions, not permission to invent historical facts or penalize old non-response. Reconciliation at cutover is mandatory. Decide separately whether to re-invite unanswered legacy offers.
- Keep legacy raw statuses (`DECLINED`, `CHANGE_REQUESTED`) as historical records. New appointments must use confirmed/cancelled/completed/no-show/superseded states. Replace old APIs rather than teaching new consumers two competing state machines.
- Model-only checks cannot validate a caller's identity or intent. Preserve existing authorization and listing-before-application lock order in all later commands.
- No destructive rollback migration is provided: dropping the new tables after live CURRENT writes would discard negotiation history. Revert rollout before activation, or use a forward repair after activation.

## Tests

`test/viewing-workflow-model.e2e-spec.ts` builds an isolated schema in the guarded `renyqo_e2e` database, replays the actual historical migrations, seeds all legacy states and corrected outcomes, and applies the real new migration. Tests verify backfill identity/history, simultaneous confirmation/replacement, atomic swaps, ownership, immutability, attribution, deadline boundaries and stale snapshot behavior. Existing viewing/attention/read-model cleanup explicitly includes the new referencing tables; no CASCADE cleanup against production data is introduced.
