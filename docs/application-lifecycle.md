# Application Lifecycle

Application HTTP contracts are documented in [API](api.md#applications). This page is the domain source for status, eligibility, queue, rent, and related rate-limit behavior.

## Statuses

Application statuses are `ACTIVE`, `WAITING`, `REJECTED`, `WITHDRAWN`, and `ACCEPTED`.

Application terminal states are `REJECTED`, `WITHDRAWN`, `ACCEPTED` and listing `RENTED`. These states serve as the authoritative source for downstream features such as view restrictions and chat availability. `WITHDRAWN` is terminal for the row it marks, but it is the only terminal state that allows a new application row to be created afterwards; `REJECTED` and `ACCEPTED` block re-applying.

## Eligibility authority

`GET /api/v1/listings/:id/eligibility` is read-only. It performs no database mutation, loads the applicant profile of the authenticated session from the database, evaluates the current listing requirements and returns `canApply`, `reasons`, `warnings` and `evaluatedAt`. Eligibility data supplied by a client is never accepted as authoritative; the endpoint takes no request body.

`POST /api/v1/listings/:id/apply` always recalculates eligibility from current database data inside the same transaction that creates the application. A previous frontend eligibility result is never trusted. A rejected application returns `422` with the same explainable payload, where `evaluatedAt` is the timestamp of the evaluation that caused the rejection.

Only published listings accept applications. RENTED listings do not accept applications and are excluded from applicant discovery.

## Apply

The first five eligible applications are `ACTIVE`; later eligible applications are `WAITING`. Provider application lists never include `WAITING` applications, and the waiting-count endpoint returns only the count, never applicant identities, profiles, income or eligibility details. A duplicate live (`ACTIVE` or `WAITING`) application for the same listing returns `409`. Only a previous `WITHDRAWN` application allows re-applying; `REJECTED` and `ACCEPTED` applications remain terminal and also return `409` on a new application.

## Withdraw

`DELETE /api/v1/applicant/applications/:id` can be used only by the owning applicant. It accepts `ACTIVE` and `WAITING` applications, changes the status to `WITHDRAWN`, and returns the application status and dates without exposing applicant or provider internals. Repeating the request for an already withdrawn application is idempotent. Withdrawing an `ACTIVE` application releases one slot and promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

## Re-apply after WITHDRAWN

Withdrawing no longer permanently blocks re-applying. `POST /api/v1/listings/:id/apply` creates a new application row with a new `id` and a new `queueOrder` when the applicant's most recent application for that listing is `WITHDRAWN`. The previous `WITHDRAWN` row is kept unchanged as history. The new status is recalculated from the current listing state, so a re-application may be `ACTIVE` (if a slot is free) or `WAITING` (if the active limit is full). Re-applications are subject to the same `PUBLISHED` listing and eligibility checks as first-time applications. `REJECTED` and `ACCEPTED` applications remain terminal and block new applications.

## Waiting queue promotion

Promotion is an internal backend operation with no HTTP endpoint. Providers cannot promote a waiting applicant manually, and the queue is never reordered by income, assets, SCHUFA or provider preference.

`ApplicationsService.promoteWaitingApplications(listingId)` promotes the oldest eligible `WAITING` applications by `queueOrder`, rechecks eligibility immediately before each promotion and stops at the five-active limit. It runs in a Serializable transaction with row locks and serialization-conflict retries, so concurrent promotions can never exceed five `ACTIVE` applications.

Withdrawing an `ACTIVE` application calls the private `promoteWithinTransaction(tx, listing)` inside the same Serializable transaction that writes the `WITHDRAWN` status, immediately after that update. That keeps slot release and FIFO promotion atomic. Ownership is enforced before the slot is released.

## Reject

`PATCH /api/v1/provider/applications/:id/reject` requires an authenticated provider session that owns the listing. Only `ACTIVE` applications may be rejected; `WAITING` applications are not visible to the provider and return `404`. The rejection reason is always `NOT_SELECTED` and is stored in `publicReason` alongside `rejectedAt`. Invalid state transitions return `409`. Rejecting an `ACTIVE` application promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

## Restore

`PATCH /api/v1/provider/applications/:id/restore` lets a provider bring back a `REJECTED` application whose `publicReason` is `NOT_SELECTED`. Owning providers get `404` for foreign or missing applications, and any other state (`WITHDRAWN`, `ACCEPTED`, or system rejections such as `LISTING_RENTED` and `PROFILE_NO_LONGER_ELIGIBLE`) returns `409`. The slot/queue decision is made transactionally under `Serializable` with listing and application row locks: if fewer than five `ACTIVE` applications exist the application returns to `ACTIVE` with a new `activeAt`; otherwise it is appended to the end of the listing's `WAITING` queue with a fresh `queueOrder`. On restore the current-state rejection fields (`rejectedAt`, `publicReason`) are cleared; a restore to `WAITING` also clears `activeAt`.

Provider reject and restore transitions are recorded as append-only `ListingEvent` history rows so prior `ACTIVE` / `REJECTED` states are never lost, even when the current-state `Application` row is restored. A backend-enforced cooldown rejects rapid `REJECT`→`RESTORE`→`REJECT` toggling with `429` and `code: "PROVIDER_CURATION_RATE_LIMITED"` when a provider curation event for the same application happened within the last 60 seconds. History rows are immutable and never cascade-deleted by listing or application deletion, forming the foundation for the future Objektakte (full listing timeline).

## Rent

`PATCH /api/v1/provider/listings/:id/rent` requires `{ "selectedApplicationId": "uuid" }`. The listing must be `PUBLISHED` or `PAUSED`, and the selected application must be `ACTIVE` and belong to the listing. In one atomic Serializable transaction:

- Listing changes to `RENTED` with `rentedAt` set.
- The selected application changes to `ACCEPTED`.
- Every other `ACTIVE` and `WAITING` application changes to `REJECTED` with `publicReason` set to `LISTING_RENTED` and `rejectedAt` set.
- No waiting application is promoted.

RENTED listings disappear from applicant discovery and do not accept new applications.

## Application action rate limit

`POST /api/v1/listings/:id/apply` and `DELETE /api/v1/applicant/applications/:id` share a backend rate-limit bucket keyed by the authenticated applicant and listing. Four application actions are allowed per 60 seconds; the fifth rapid action returns `429` with `code: "APPLICATION_ACTION_RATE_LIMITED"`. This permits two complete apply/withdraw cycles in a short window while limiting automated history-row abuse. The application-scoped in-memory storage implements the NestJS throttler contract and applies per backend process; configure shared throttler storage before running multiple replicas.
