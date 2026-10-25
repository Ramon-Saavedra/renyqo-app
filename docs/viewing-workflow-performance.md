# Pre-PR Phase C: transaction scope and fanout

Listing archive/unpublish/rental still closes viewing commitments in the same
Serializable transaction as listing/application status, history, notifications and
outbox writes. Listing-before-application lock order is unchanged. No work moved
to a background job. Rental already bulk-updates non-selected ACTIVE/WAITING
applications and bulk-inserts their real rejection history; those semantics remain.

The listing viewing closer now selects only open workflows, live legacy/current
ledger commitments, unimported legacy history, or unanswered decision metadata.
Closed historical workflows and applications with no viewing are skipped before
application locking and full lifecycle composition. The 22-application regression
calls the closer once instead of 22 times, for both archive and rental. Individual
lifecycle paths retain the shared historical guard: existing closedAt/closureReason
are never replaced. Calendar-only closure with pending interest still needs cleanup;
an imported closed snapshot with live legacy commitments also still needs cleanup.

Listing invalidation keeps application-scoped rows and current event contracts.
Before: one application scan plus N transaction-ID queries and N upserts.
After: one scan, one transaction-ID query and one createMany/skipDuplicates call.
The same transaction/application/type deduplication key preserves existing activity
invalidations. An existing effective activity event retains its occurrence time.
No domain history or durable notification is removed. Row count is unchanged.

Application viewing changes, decisions and application lifecycle changes still
need application-specific routing/targets. At the provider socket boundary the
existing router can safely reduce a hidden application's invalidation to listing
scope. Consolidating stored listing fanout into a single event would also require
new applicant fanout and authorization semantics; a provider listing room alone
would miss offline/connected applicants and ownership/visibility changes. This
phase batches persistence instead. Delivery-time authorization, WAITING identity
redaction and all-tabs routing are unchanged.

Provider overview attention previously composed every visible application in
200-row chunks, including conversations, documents, viewing groups, outcome
history and consideration activities. It now excludes inactive applications
without potentially relevant attendance/outcome history from aggregate-only
composition. Requested card details remain composed. ACCEPTED, OUTCOME_PENDING,
COMPLETED and NO_SHOW viewing histories remain candidates even on terminal
applications, preserving attendance obligations and correction/revalidation
boundaries. The regression composes one terminal attendance candidate instead
of 26 historical applications and matches workspace attention. Counts/recent exits
still use their existing queries. ACTIVE applications without obligations still
need composition to establish unread/document/viewing facts; no duplicate pending
state or heuristic SQL substitute was introduced. The general attention aggregate
and portfolios with extensive completed viewing histories remain potentially
expensive; this is deliberately a conservative optimization.

The legacy applicant listing query now returns at most one image per application,
ordered cover first, position ascending, then ID. Both cover and no-cover fallback
match existing DTO behavior. Pagination is unchanged.

## Activity lookup measurement

The real consideration lookup filters by application_id, activity type and
payload->>'workflowId', then orders by application, numeric workflow revision,
occurrence and ID for DISTINCT ON. The database already indexes
(application_id, occurred_at, id). The dedicated database was empty at measurement
start, so a session-local temporary table copied the real table/index definitions;
no persistent rows or schema were changed. EXPLAIN ANALYZE used 100,000 activities,
1,000 applications, 1,000 consideration decisions and a 200-workflow batch.

The existing index produced a bitmap scan of 20,000 application-scoped rows,
filtered 19,800, sorted 200 rows (39 kB), and finished in 4.259 ms locally. This is
a synthetic shape check, not production latency evidence. No partial/expression
index or migration is added: current evidence does not establish this lookup as
the bottleneck. Re-measure production row density, buffers and latency; if it
becomes material, a partial (application_id, (payload->>'workflowId')) index for
viewing_consideration_changed is the narrow candidate. Do not add a broad JSON
GIN index for this scalar lookup.

Remaining transaction cost scales with genuinely affected applications: real
rejection history, durable notifications and per-application invalidation remain
atomic. Large listings can still hold their listing lock while these necessary
effects are written. This phase does not weaken consistency to shorten that lock.
