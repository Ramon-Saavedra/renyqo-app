# Viewing expiry and time-driven processing (Phase 8)

## Durable rules

`ViewingWorkflowExpiryService` processes only authoritative CURRENT workflows. A pending proposal expires at its persisted response deadline: normally 12 elapsed hours after creation, shortened for explicit short-notice schedules and bounded by the proposed/base appointment start. Applicant alternatives and provider replacements use that same deadline model. SYSTEM resolves the exact proposal as EXPIRED, clears only the pending pointer, increments the workflow revision and appends `VIEWING_PROPOSAL_EXPIRED`. The confirmed appointment, application status, ACTIVE consideration position and capacity stay unchanged. A provider can issue a new invitation afterward.

Completed viewings request interest for 48 elapsed hours from recorded completion (including a correction to completion). At the exact deadline an unanswered CURRENT request expires. The existing lifecycle helper verifies the exact latest completed appointment, pending request, current revision, open workflow (or a calendar-only PROVIDER_CLOSED workflow), ACTIVE application and PUBLISHED/PAUSED listing under locks. It records SYSTEM `VIEWING_INTEREST_EXPIRED`, closes future commitments, rejects with `POST_VIEWING_RESPONSE_EXPIRED`, records real application history and invokes existing capacity/promotion logic. It does not create voluntary withdrawal, provider rejection attribution or a NOT_SELECTED cooldown. PAUSED listings retain their existing promotion policy.

A newer completed viewing closes earlier pending interest requests. A stale older request cannot reject the newer decision. A new invitation alone does **not** extend an existing interest deadline. Explicit interest before the deadline wins; at or after the deadline it cannot be submitted. Previously responded, closed, cancelled, superseded and terminal requests are no-ops. LEGACY workflows, legacy proposal placeholders and LEGACY_UNANSWERED interest have no invented deadlines or retrospective timeout rejection; reconciliation/provider action remains required.

All effective expiry effects, history and Phase 7 outbox records share one Serializable transaction. Listing locks precede application locks; proposal rows are never claimed first. Each attempt reloads the exact target under those locks. Concurrent workers, lifecycle commands and interactive commands serialize/retry through the existing transaction helper. A loser rechecks and becomes a no-op or returns the existing structured `409 VIEWING_STATE_CHANGED`; it never applies an old proposal intent to a newer target. A command receipt replay creates no extra effects. No new endpoints, schema migration or infrastructure are required; Phase 2 deadline indexes are reused.

## Delayed-worker correctness

Reads remain side-effect free. Proposals are effectively expired and absent from response attention at their deadline even before persistence. Post-viewing reads expose `state: EXPIRED`, `storedState: PENDING`, and `lifecycleExpiryPending: true` while persistence is overdue. Interest, consideration and new viewing mutations are unavailable in that interval; unrelated attendance evidence can still be resolved. Existing `nextRevalidateAt` exposes the next future capability boundary, never a past expiry deadline or an artificial polling deadline.

Viewing commands opportunistically use the same expiry operations. A late command commits the due transition and a failed command receipt, then returns a structured conflict outside the transaction. Retrying the same request stays deterministic; a new intent requires a fresh revision/key. Existing lifecycle status, chat policy and capacity reflect committed state: they are not fabricated as REJECTED by a GET. If all processing is stopped, an overdue application can therefore remain stored ACTIVE until restart or an authorized viewing command triggers persistence. The explicit pending-expiry projection prevents a false response capability during that delay; operational monitoring must detect a stopped worker.

## Derived boundaries

| Boundary                         | Behavior                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six hours before confirmed start | Applicant normal alternative capability closes; cancellation remains available until start and is attributed as late where appropriate. No worker event.       |
| Appointment start                | Calendar cancellation/replacement closes. Pending replacement response deadlines cannot extend beyond the existing commitment's start. No inferred attendance. |
| Appointment end                  | Provider attendance/outcome becomes due in HTTP attention. No automatic COMPLETED or NO_SHOW.                                                                  |
| First outcome + 24h              | Existing correction window closes at equality. No persisted transition/event.                                                                                  |
| Proposal response deadline       | Derived immediately, then durably expired with history and viewing invalidation.                                                                               |
| Recorded completion + 48h        | Derived immediately, then durably expires interest and applies SYSTEM lifecycle rejection.                                                                     |

All durations are elapsed UTC time, not local-calendar days; daylight-saving transitions do not add/subtract an hour. Existing timestamps and IANA timezone storage remain unchanged. Production uses the shared server ViewingClock and persisted database deadlines; callers never supply the current time. Keep API hosts synchronized to UTC/NTP. Scheduler timing and in-memory timers do not determine eligibility.

## Scheduling and recovery

`ViewingExpiryScheduler` follows the existing in-process outbox poller architecture. It scans immediately at startup, then waits **30 seconds after the previous batch finishes**. Defaults are enabled outside NODE_ENV=test, disabled in tests; explicit configuration overrides that default:

```dotenv
VIEWING_EXPIRY_ENABLED=true
VIEWING_EXPIRY_INTERVAL_MS=30000
VIEWING_EXPIRY_BATCH_SIZE=50
```

Validated limits: interval 1,000–3,600,000ms, batch 1–500. Two indexed candidate queries each read at most batch-size rows; deadline/ID ordering merges them into at most 50 default processing attempts. Each target owns its own short Serializable transaction; one failure cannot roll back a successfully processed neighbor. No overlapping scheduler poll runs in one instance. Shutdown cancels the next timer and awaits current work. A process killed mid-transaction rolls back; a process killed after commit leaves a resolved row that the next scan skips.

Serialization retries use the existing bounded retry/backoff helper. Failed rows remain durably due and are retried on subsequent sweeps indefinitely; errors log `VIEWING_EXPIRY_FAILED` with target identifiers only. Candidate query failure logs `VIEWING_EXPIRY_POLL_FAILED` and the next poll retries. There is no lossy scheduled job per appointment, persisted recipient list, external queue or Redis. Restart discovers all overdue persisted rows, including arbitrarily old deadlines, in bounded batches. Multiple executions are domain-safe, although overlapping instances can do redundant selection and contend on listing locks. Phase 7's single-API realtime delivery restriction still applies.

Monitor worker error signals, oldest overdue deadline/count, transaction latency and outbox backlog. A large outage backlog takes multiple polls to drain. A bounded keyset sweep advances past every attempted target, including failures and no-ops, ordered by deadline, ID and target kind. Each sweep fixes its due-time cutoff so newly arriving deadlines cannot indefinitely postpone retries. At the end it wraps and retries unresolved rows; nothing is abandoned. The cursor is local to each worker and overlapping calls on one instance are serialized. Restart resets scan progress without losing durable obligations; repeated restarts before a sweep advances can delay progress. Permanent failures still require operator repair, but cannot monopolize every batch during a running sweep. Do not silently dead-letter an interest timeout and leave the application active indefinitely. Increase validated batch/frequency settings only after observing database contention. No global lease is needed for correctness; no new scheduler infrastructure is introduced.

A valid pending completed-viewing interest request also expires after a calendar-only PROVIDER_CLOSED. SYSTEM rejection and promotion remain atomic; the historical closure date/reason are preserved, with one revision increment and no duplicate calendar-closure activity. Explicitly configure the three settings above in production after migrations; keep the existing default rather than changing activation semantics in this cleanup.

## Product boundaries and later phases

No deadline is invented for provider attendance recording, provider consideration after a valid STILL_INTERESTED response, or unresolved legacy decisions. Those can remain pending and need future product escalation/reminder policy. Expiry never means no-show, and a missed invitation never rejects an application. A confirmed appointment remains binding if its replacement expires, even when expiry happens at the confirmed appointment's start.

Phase 7 `application.viewing.changed` and, for lifecycle timeout, `application.lifecycle.changed` are emitted transactionally. Promotion emits its own lifecycle hint. Socket payloads contain no expiry reason, state copy or appointment DTO; HTTP stays authoritative. Derived boundaries rely on Phase 6 revalidation targets plus reconnect/focus refetch rather than extra time-tick socket events.

Durable offline viewing notifications are implemented in [Phase 9](viewing-workflow-notifications.md) and remain separate from this expiry phase. Email/push and future reminders are not implemented.
