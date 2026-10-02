# Application Viewings

Viewings are internal Renyqo appointments scoped to an application. Providers control schedules; applicants respond without editing them. Calendar integrations and notification delivery are not part of this module.

## Access and lifecycle

Provider access requires listing ownership, a non-WAITING application, and current or previous ACTIVE visibility. WAITING and never-active hidden applications return the same 404 as inaccessible applications, including history and summaries. Applicants access only their own application. Every viewing lookup is scoped by both applicationId and viewingId.

All writes require ACTIVE and a PUBLISHED or PAUSED listing, including interest and corrections. Terminal applications retain authorized historical reads with capabilities disabled. Restoring ACTIVE resumes an unresolved round when its timing permits the action; restoring WAITING hides it from the provider. A new application ID starts independent history.

## Proposal rounds and group viewings

Each application may have multiple immutable schedule rounds, but at most one PROPOSED or ACCEPTED round. Rescheduling before startsAt atomically marks the old round SUPERSEDED and creates the next PROPOSED round. The applicant must accept again. Dates, timezone and provider instructions on old rounds remain unchanged.

Overlapping appointments across different applications are intentionally allowed, including the same provider, listing and time. This supports Sammelbesichtigungen. There is no provider-wide time uniqueness constraint or automatic conflict rejection.

## Responses

Before startsAt, an applicant may accept, decline or request another time. An accepted applicant may subsequently decline or request another time. DECLINED and CHANGE_REQUESTED close the round. The provider may then create a new proposal. A change request optionally carries 1–500 trimmed plain-text characters; it never changes dates automatically. Repeating the identical response is idempotent; changing a final response or change-request message returns 409.

Provider cancellation closes a PROPOSED or ACCEPTED round, including overdue rounds. Applicants cannot cancel or directly edit the schedule. An unanswered past proposal remains PROPOSED until explicitly cancelled; it is never automatically recorded as NO_SHOW.

## Time contract

Propose and reschedule require startsAt, endsAt and an IANA timeZone such as Europe/Berlin. ISO timestamps require seconds and an explicit Z or numeric offset, with at most millisecond precision. Z represents a UTC instant and may be paired with any supported zone. Numeric-offset timestamps must match the zone's local time at that instant, rejecting DST gaps and offset mismatches; repeated autumn times are disambiguated by their explicit offset. Timezone-less strings and timezone abbreviations are rejected.

Instants use PostgreSQL timestamptz(3); API timestamps are UTC ISO strings, with timeZone returned separately. Duration must be 5–240 elapsed minutes. startsAt must be strictly future at the authoritative transaction check; there is no additional minimum lead time. Translated date strings are never stored.

## Outcomes and controlled correction

An owning provider may record COMPLETED or NO_SHOW only for an ACCEPTED round at or after endsAt. Opposite outcomes conflict; identical retries add no event.

Outcome decisions are append-only ApplicationViewingOutcome rows. Revision 1 is the original decision. The provider may append revision 2 once, for the latest round, strictly within 24 hours of the original decision, before any interest response. A different outcome and a required 1–500-character plain-text correction reason are mandatory. The effective viewing status changes transactionally while the original decision, timestamp and activity remain visible. Identical correction retries are idempotent; further corrections conflict. Starting another round closes correction eligibility for the previous round.

## Post-viewing interest

After effective COMPLETED, the owning applicant may submit STILL_INTERESTED or NOT_INTERESTED for that exact viewing. Responses are final; identical retries are idempotent and contradictory responses return 409. No interest is inferred. NO_SHOW rejects interest. Providers can read interest under normal application access rules. Interest never changes application ranking or lifecycle. An unresponded completed historical round remains eligible while the application process permits writes.

## Read semantics and next actions

The list response returns latestViewing (highest round), currentViewing (the unresolved PROPOSED/ACCEPTED round or null), latestCompletedViewing (highest effectively COMPLETED round), pendingInterestViewing (highest completed round without interest), and changeRequestedViewing (latest round only when CHANGE_REQUESTED). History is a bounded newest-first page containing all statuses, including current/latest rows; beforeRound is an exclusive cursor, with nextBeforeRound and hasMore.

Each row exposes safe fields, outcome history, interest, capabilities, isOverdue and a lifecycle blocking reason. requestKey, requestHash, internal outcome/interest IDs and user/profile data are excluded. Notes and correction reasons are plain text and clients must render them as text, never HTML. When an accepted current viewing is waiting for its end and has NONE, the page may surface interest awaiting a response on an older completed round.

Derived nextAction values are APPLICANT_RESPOND_TO_VIEWING, PROVIDER_RESPOND_TO_CHANGE_REQUEST, PROVIDER_RECORD_VIEWING_OUTCOME, PROVIDER_CLOSE_UNANSWERED_VIEWING, APPLICANT_CONFIRM_POST_VIEWING_INTEREST and NONE. They identify the responsible participant independently of the reader's role. The page prioritizes the unresolved round's action, then a latest change request, then pending interest. Row-level actions preserve visibility of additional completed rounds awaiting interest. Before an accepted viewing ends, the workflow waits with NONE. Inactive application processes return NONE. Badge records and translated strings are not persisted.

## API

Both audiences use /api/v1/{provider|applicant}/applications/:applicationId/viewings for GET list and GET /:viewingId for detail.

Provider: POST collection to propose; POST /:viewingId/reschedule; PATCH /:viewingId/cancel, /complete, /no-show, /correct-outcome. Applicant: PATCH /:viewingId/accept, /decline, /request-another-time, /interest. All routes require session authentication and their audience role; existing CSRF protection applies.

Proposal/reschedule body: requestKey (UUID v4), startsAt, endsAt, timeZone, optional providerNote. Change-request body: optional message. Correction body: outcome (COMPLETED or NO_SHOW), reason. Interest body: interest (STILL_INTERESTED or NOT_INTERESTED). Other action bodies must be empty objects. Inputs reject unknown fields. No global viewing API exists.

## Transactions and events

Writes authorize, lock listing then application, reread authorization/lifecycle, and mutate under Serializable isolation with the existing retry helper. Activity writes share the transaction. Reads use Repeatable Read. The partial unique index enforces one unresolved round; unique application/round and application/requestKey constraints protect history and idempotency.

Proposal/reschedule retries match the canonical command, source round, instants, zone and trimmed note hash. Matching keys return the original round's current representation; changed inputs return 409. Authorization and lifecycle checks precede replay lookup; replay precedes fresh time/current-round checks. Keys are scoped per application. A previously successful operation may therefore return a subsequently superseded round without creating a new proposal. Final-state retries add no activities.

Activity types cover proposed, accepted, declined, change requested, rescheduled, cancelled, completed, no-show, corrected outcomes and both interest responses. Metadata includes only allowlisted viewing identifiers, rounds, schedule timestamps and outcome revisions, never notes or profiles. Notifications can consume these events later without changing domain states.

## Validation

Database checks require each closing timestamp exactly when its status applies, forbid acceptance on PROPOSED, and require acceptance for ACCEPTED and effective outcomes. Accepted timestamps remain valid historical fields on declined, change-requested, cancelled and superseded rounds. Completion/no-show timestamps live in the append-only outcome decisions, rather than separate viewing columns.

Outcome revisions are limited to 1 and 2, unique per viewing. An insert trigger requires revision 1 before a different revision 2 and rejects updates/deletes of outcome decisions and final interest responses. Deferred constraint triggers require the viewing status to match the latest decision and allow interest only with effective COMPLETED. Child inserts write-lock and version the parent viewing without changing its updated timestamp, serializing concurrent decisions and rejecting stale Repeatable Read/Serializable writes. The status and decision may be written in either order within one transaction.

Direct PostgreSQL integrity tests bypass all services and exercise invalid timestamps, revision ordering, effective outcome mismatches, interest restrictions, preserved correction history and stale snapshots. Dedicated test cleanup truncates the three viewing tables together because audit rows cannot be deleted through ordinary row mutations.

Focused tests cover DTO validation, DST and temporal boundaries, capabilities and next actions. PostgreSQL E2E covers full workflows, privacy, grouping, duplicate protection, concurrent commands, idempotency and atomic rollback. The migration is additive and creates no historical proposals or interest responses.
