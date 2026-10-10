# Application Lifecycle

Viewing rules are defined in [Application Viewings](application-viewings.md). All viewing writes require ACTIVE and a PUBLISHED or PAUSED listing. Terminal states retain authorized history without rewriting viewing records. Restoration to ACTIVE resumes an unresolved round when time permits; restoration to WAITING hides all viewing surfaces from providers.

Application HTTP contracts are documented in [API](api.md#applications). This page is the domain source for status, eligibility, queue, rent, and related rate-limit behavior.

## Statuses

Application statuses are `ACTIVE`, `WAITING`, `REJECTED`, `WITHDRAWN`, and `ACCEPTED`.

Only `ACTIVE` and `WAITING` are current/live application attempts. `REJECTED`, `WITHDRAWN` and `ACCEPTED` end the application process; listing `RENTED` also closes it. `ACCEPTED` and `LISTING_RENTED` rejections continue blocking fresh submissions. Rejected history is retained, while permitted re-submissions create new rows. Provider restoration is a separate same-row exception for `NOT_SELECTED`.

## Eligibility authority

`GET /api/v1/listings/:id/eligibility` is read-only. It performs no database mutation, loads the applicant profile of the authenticated session from the database, evaluates the current listing requirements and returns `canApply`, `reasons`, `warnings` and `evaluatedAt`. Eligibility data supplied by a client is never accepted as authoritative; the endpoint takes no request body.

`POST /api/v1/listings/:id/apply` evaluates admission history and recalculates eligibility from current database data inside the same Serializable transaction that creates the application, under the existing listing lock. A previous frontend eligibility result is never trusted. An ineligible submission returns `422` with the explainable eligibility payload and creates no application row.

Only published listings accept applications. RENTED listings do not accept applications and are excluded from applicant discovery.

## Apply

The first five eligible applications are `ACTIVE`; later eligible applications are `WAITING`. Provider application lists never include `WAITING` applications, and the waiting-count endpoint returns only the count, never applicant identities, profiles, income or eligibility details. A duplicate live (`ACTIVE` or `WAITING`) application returns `409`; the database partial unique index continues enforcing one live row per applicant/listing. Historical admission restrictions are enforced by the applications domain.

## Withdraw

`DELETE /api/v1/applicant/applications/:id` can be used only by the owning applicant. It accepts `ACTIVE` and `WAITING` applications, changes the status to `WITHDRAWN`, and returns the application status and dates without exposing applicant or provider internals. Repeating the request for an already withdrawn application is idempotent. Withdrawing an `ACTIVE` application releases one slot and promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

## Re-apply after WITHDRAWN

Withdrawing permits a fresh application subject to admission history, current eligibility and a `PUBLISHED` listing. Previous withdrawn and rejected rows remain unchanged. The new attempt has a new `id`, submission timestamp and `queueOrder`; it becomes `ACTIVE` if a slot is free or `WAITING` at its fresh queue position otherwise. Documents, conversations, viewings and activities remain attached to their original attempt.

## Re-apply after rejection

`PROFILE_NO_LONGER_ELIGIBLE` starts no cooldown. Profile recovery does not revive the old row; a currently eligible applicant may submit a fresh attempt, unless another admission restriction applies.

Manual provider rejection (`NOT_SELECTED`) blocks fresh applicant submission for exactly 720 elapsed hours. The latest relevant provider rejection across all attempts for the applicant/listing pair governs expiry. At the exact expiry timestamp submission is allowed, subject to current eligibility, a `PUBLISHED` listing and no live or accepted application. Profile changes, subsequent withdrawal, same-row restoration or newer automatic rejection cannot erase an unexpired cooldown.

The authoritative timestamp is the immutable `REJECTED_BY_PROVIDER` event with source `PROVIDER` and reason `NOT_SELECTED`. An identifiable `NOT_SELECTED` row without that event falls back to its actual `rejectedAt`. Missing reliable dates or an unidentified rejection block submission with `APPLICATION_HISTORY_REQUIRES_REVIEW`; `createdAt` and `updatedAt` are never used as cooldown dates. No cooldown deadline is persisted and no historical data migration is required.

An active cooldown returns `409` with `code: APPLICATION_REAPPLICATION_COOLDOWN` and ISO timestamp `reapplyAvailableAt`. Current ineligibility remains `422`. `DRAFT`, `PAUSED`, `ARCHIVED` and `RENTED` listings do not accept fresh submissions. Rental-completion rejection (`LISTING_RENTED`) starts no manual-rejection cooldown and retains its existing blocking behavior.

Listing summary/detail responses include `admission { hasApplicationHistory, currentApplicationId, currentApplicationStatus, canSubmitApplication, submissionBlockReason, reapplyAvailableAt }`. Existing `hasApplied`, `applicationStatus` and `publicReason` remain compatible historical indicators, not submission permission. `hasApplicationHistory` also includes withdrawn rows. Anonymous/non-applicant admission returns `AUTHENTICATION_REQUIRED`. Eligibility endpoints remain solely about requirement matching.

## Waiting queue promotion

Promotion is an internal backend operation with no HTTP endpoint. Providers cannot promote a waiting applicant manually, and the queue is never reordered by income, assets, SCHUFA or provider preference.

`ApplicationsService.promoteWaitingApplications(listingId)` promotes the oldest eligible `WAITING` applications by `queueOrder`, rechecks eligibility immediately before each promotion and stops at the five-active limit. It runs in a Serializable transaction with row locks and serialization-conflict retries, so concurrent promotions can never exceed five `ACTIVE` applications.

Withdrawing an `ACTIVE` application calls the private `promoteWithinTransaction(tx, listing)` inside the same Serializable transaction that writes the `WITHDRAWN` status, immediately after that update. That keeps slot release and FIFO promotion atomic. Ownership is enforced before the slot is released.

## Reject

`PATCH /api/v1/provider/applications/:id/reject` requires an authenticated provider session that owns the listing. Only `ACTIVE` applications may be rejected; `WAITING` applications are not visible to the provider and return `404`. The rejection reason is always `NOT_SELECTED` and is stored in `publicReason` alongside `rejectedAt`. Invalid state transitions return `409`. Rejecting an `ACTIVE` application promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

## Restore

`PATCH /api/v1/provider/applications/:id/restore` lets a provider bring back a `REJECTED` application whose `publicReason` is `NOT_SELECTED`. Owning providers get `404` for foreign or missing applications, and any other state (`WITHDRAWN`, `ACCEPTED`, or system rejections such as `LISTING_RENTED` and `PROFILE_NO_LONGER_ELIGIBLE`) returns `409`. The slot/queue decision is made transactionally under `Serializable` with listing and application row locks: if fewer than five `ACTIVE` applications exist the application returns to `ACTIVE` with a new `activeAt`; otherwise it is appended to the end of the listing's `WAITING` queue with a fresh `queueOrder`. On restore the current-state rejection fields (`rejectedAt`, `publicReason`) are cleared; a restore to `WAITING` also clears `activeAt`.

Provider reject and restore transitions are recorded as append-only `ListingEvent` history rows so prior `ACTIVE` / `REJECTED` states are never lost, even when the current-state `Application` row is restored. A backend-enforced cooldown rejects rapid `REJECT`→`RESTORE`→`REJECT` toggling with `429` and `code: "PROVIDER_CURATION_RATE_LIMITED"` when a provider curation event for the same application happened within the last 60 seconds. History rows are immutable and never cascade-deleted by listing or application deletion, forming the foundation for the future Objektakte (full listing timeline).

The applicant 720-hour cooldown does not apply to provider restoration. Restoring an obsolete attempt returns `409` with `APPLICATION_ATTEMPT_SUPERSEDED` when another attempt has a later submission timestamp, even if that newer attempt was withdrawn. Fresh submissions receive a timestamp strictly after their history to disambiguate rapidly repeated attempts. Provider workspace `canRestore` uses the same safeguard. Listing locks, Serializable retries and the live-only unique index protect concurrent fresh submission/restoration.

## Rent

`PATCH /api/v1/provider/listings/:id/rent` requires `{ "selectedApplicationId": "uuid" }`. The listing must be `PUBLISHED` or `PAUSED`, and the selected application must be `ACTIVE` and belong to the listing. In one atomic Serializable transaction:

- Listing changes to `RENTED` with `rentedAt` set.
- The selected application changes to `ACCEPTED`.
- Every other `ACTIVE` and `WAITING` application changes to `REJECTED` with `publicReason` set to `LISTING_RENTED` and `rejectedAt` set.
- No waiting application is promoted.

RENTED listings disappear from applicant discovery and do not accept new applications.

## Application action rate limit

`POST /api/v1/listings/:id/apply` and `DELETE /api/v1/applicant/applications/:id` share a backend rate-limit bucket keyed by the authenticated applicant and listing. Four application actions are allowed per 60 seconds; the fifth rapid action returns `429` with `code: "APPLICATION_ACTION_RATE_LIMITED"`. This permits two complete apply/withdraw cycles in a short window while limiting automated history-row abuse. The application-scoped in-memory storage implements the NestJS throttler contract and applies per backend process; configure shared throttler storage before running multiple replicas.
## Application conversations

Each application owns at most one text conversation. A new application ID on re-application starts a separate conversation. Conversation history is retained through lifecycle changes.

The provider opens a conversation by sending its first message. Applicants cannot initiate. Subsequent turns are derived from the last message: PROVIDER → APPLICANT → PROVIDER. Sending and lifecycle mutations share listing-before-application locking and Serializable isolation. No pending-action or next-action state is persisted.

Sending requires an ACTIVE application and a PUBLISHED or PAUSED listing. PAUSED stops new applications while allowing existing participants to communicate. DRAFT, ARCHIVED and RENTED listings disable sending. REJECTED, WITHDRAWN, ACCEPTED and WAITING applications disable sending. Existing history remains readable and incoming messages can still be marked as read by authorized participants.

As explicitly approved for this phase, restoration to ACTIVE resumes messaging in the same conversation, retaining history and the previous turn. Restoration to WAITING disables sending and hides all conversation surfaces from the provider until the application becomes ACTIVE again. No separate reopening endpoint exists.

Provider access requires listing ownership, a non-WAITING application and current or prior ACTIVE visibility. Never-visible rejected/withdrawn WAITING applicants stay hidden. Applicant access always requires ownership of that exact application. Conversation DTOs expose no applicant profile or internal user IDs.
