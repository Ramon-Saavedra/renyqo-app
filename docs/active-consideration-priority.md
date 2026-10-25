# ACTIVE consideration priority (Phase 5)

ACTIVE priority is local to an application/listing. It does not affect WAITING order, five-slot capacity, eligibility, visibility, messages or applicant reputation. No Phase 6 attention redesign, realtime/outbox, worker or frontend implementation is included.

## Order and activation

The Phase 2 `ApplicationConsiderationPosition.position` is now authoritative for ACTIVE lists: ascending position, then application ID. Tokens are positive PostgreSQL BIGINT values from the existing sequence, serialized under the listing lock. They are not dense ranks; rollback gaps are expected. They are returned as decimal strings, never unsafe JSON numbers. The sequence is global only as an allocation mechanism; comparison and consequences are listing/application scoped.

An AFTER INSERT/status-transition database trigger assigns a fresh tail token whenever an application enters ACTIVE, covering admission, promotion, restore and any future activation writer. A same-status ACTIVE update does not reorder. WAITING insertion/restoration receives no new position; reactivation always replaces its old historical position with a fresh tail token. Existing application services continue owning five-ACTIVE capacity checks, release and waiting promotion. The trigger does not admit additional applicants or use `queueOrder`.

Phase 2 positions were snapshots, not maintained live projections. The additive migration establishes the actual pre-Phase-5 visible ACTIVE order from `activeAt ASC NULLS LAST, id`, assigning fresh tokens above the existing sequence/max. It reconciles missing/stale ACTIVE rows, retains inactive rows, and changes no application status, queue order or activation timestamp. It invents no historical no-show penalties. Like previous backfills, it takes ordinary transactional DDL/table locks and should be deployed with table size/traffic in mind.

## Applicant absence and correction

The existing provider workflow outcome command remains authoritative and retains exact appointment target, expected workflow revision, authorization, durable request key and transaction/activity history. An initial `NO_SHOW` with `absenceSide: APPLICANT` against the current confirmed appointment moves an ACTIVE application to the tail, with attendance, order and audit committed together. It remains ACTIVE; capacity/promotion do not change. Provider absence, BOTH absence, completion, cancellation, expired/unaccepted invitations and detached attendance after lifecycle termination do not penalize the applicant. PAUSED listings remain within the existing active-process policy.

`ApplicationNoShowConsequence` links the exact immutable outcome to its prior token, applied token and applied order revision. Source fields cannot be rewritten/deleted. The position row has its own monotonic revision, independent of workflow revision. All position updates require a different token and exactly the next order revision; the existing `(listingId, position)` uniqueness and same-listing foreign keys remain enforced.

Correction retains the existing one-correction/24-hour/no-interest-response/latest-accepted-round restrictions. It also supports correcting attribution while retaining NO_SHOW, such as APPLICANT → PROVIDER. PostgreSQL's append-only outcome guard now treats changed attendance attribution as a valid correction and still rejects identical decisions. Corrected outcome revisions remain in history.

The safest undo is conditional: restore the exact prior token only if the application remains ACTIVE and its current token **and order revision** still equal that consequence's applied values. Other applicants' tokens are never rewritten. If the application has since been reactivated or otherwise reordered, leave that newer order intact and record `positionRestored: false`. The corrected attendance marker still disappears. This preserves later valid decisions instead of blindly restoring old priority. Independent ordering changes for other applicants do not block a valid undo; their relative order is preserved. Sequence tokens are not reassigned to other applicants by any supported writer, so the prior token remains safe to reclaim.

A correction to newly applicant-attributed NO_SHOW can create a tail consequence while the latest viewing workflow remains open and the application is in the active process. Historical/out-of-process attendance is retained without a new ACTIVE penalty. Existing legacy generic/no-attribution outcomes are never interpreted as applicant absence; old attributed history may be displayed, but migration does not retrospectively move it. Correcting an old outcome without a recorded consequence changes its marker/history without inventing an order undo.

## Provider reads and marker

Updated ACTIVE order consumers:

- `/api/v1/provider/listings/:id/active-applications` (dashboard active cards).
- `/api/v1/provider/listings/:id/application-overview` (`activeApplications`, still at most five).

Those reads and the provider application workspace expose `consideration: { position, revision, applicantNoShow }`. The marker is null or `{ code: APPLICANT_NO_SHOW, appointmentId, recordedAt }`, sufficient for later display of **Nicht zum Termin erschienen**. It is derived from the latest effective outcome revision of each appointment and names the most recent still-effective applicant absence within this application. Corrected decisions cannot leave a stale persisted badge. Earlier genuine absences remain historical facts after a later successful viewing; any badge-expiry/forgiveness policy needs a separate product decision. BOTH is deliberately unpenalized because the provider was absent too; decide explicitly if another presentation is desired.

One bounded, sequential SQL batch query loads order/marker facts in the caller's read snapshot. It uses indexed appointment/outcome history and per-application LIMITs, avoids N+1 queries, and avoids Prisma issuing overlapping nested relation queries on a single pg transaction connection. The legacy active-list endpoint now reads authorization, ordered membership and consideration facts in RepeatableRead. Provider privacy/ownership gates remain unchanged. Applicant-facing rank/reputation is not introduced.

No ACTIVE cursor exists: both ordered lists return the five ACTIVE slots. Listing pagination, submission history, activity/outcome chronology, recent exits and applicant chronological lists are unchanged. `activeAt` remains historical metadata. Provider recent-exit cards retain their chronological domain order; detailed attendance facts remain available through the authorized workspace/history.

## Concurrency, integrity and later invalidation

Commands retain listing → application → workflow lock order and Serializable retries. Every allocator uses the existing sequence and listing lock; two no-shows or admission/promotion/restore cannot allocate colliding tail positions. The retry helper additionally recognizes the pg adapter's unwrapped commit-time SQLSTATE 40001, observed in real concurrent tests, without retrying constraint failures. Durable command receipts prevent duplicate outcome effects. Stale workflow commands still return structured `409 VIEWING_STATE_CHANGED`.

The audit table has source/correction outcome foreign keys, same-application/listing ownership, correction-shape checks and immutable source guards. Correction identifies the exact source attendance outcome; its bookkeeping cannot overwrite unrelated history. Test fixtures now explicitly clean the new referencing tables and automatic position rows within their existing guarded E2E database cleanup.

Future `application.viewing.changed` and lifecycle invalidation must refresh the affected listing's ACTIVE collection/order as well as the changed application card/workspace. HTTP remains authoritative. No event transport or outbox writes are added in this phase.

Remaining product decisions: marker forgiveness/expiry, BOTH presentation, missed-attendance operational dispute handling beyond the existing correction window, and any future manual provider ordering. Such a reorder must increment this same order revision; it must not reuse WAITING queue numbers or old tokens. No cross-listing or global penalty is implied.

Focused tests cover the populated migration, deterministic activation/promotion/restore, unchanged capacity/queue/privacy, marker consistency, both correction forms, later-order preservation, concurrent no-shows/admission/correction/restore, retries, stale/invalid targets, PostgreSQL guards and atomic rollback. Existing provider read query bounds/no-overlap assertions remain in place, with one bounded query added for the new facts.
