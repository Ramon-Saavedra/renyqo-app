# Canonical schema and rollout after Phases 1–9

This is the current backend deployment reference. The phase documents describe
their implementation boundaries; references there to later phases are historical.
Commands, lifecycle integration, ACTIVE priority, read models, realtime, expiry
and durable notifications are implemented. Frontend integration and production
activation remain deployment work, not evidence that a legacy client has migrated.

## Canonical schema

The ordered, checked-in migration SQL is authoritative for PostgreSQL, including
hand-written functions, CHECKs, partial indexes and deferred triggers. Prisma is
the representable projection of that schema. Do not use db push or blindly apply
migrate diff output to replace these invariants. Never edit an applied migration.

Phase D replays all 43 existing migrations in an isolated schema in the guarded
test database and compares it with Prisma. The representable diff is empty after
metadata alignment; no new migration or database conversion is introduced.

| Reviewed drift                                                                                              | Canonical representation                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application active/rejected/withdrawn timestamps, listing rented timestamp, application activity occurrence | Original TIMESTAMPTZ (six-digit precision), represented as `@db.Timestamptz(6)`. Preserve instants and precision; do not downcast to TIMESTAMP or round existing history to milliseconds. |
| New workflow/proposal/appointment/outcome/notification timestamps                                           | Keep the precise native types already specified by their migrations, generally TIMESTAMPTZ(3). Unrelated legacy TIMESTAMP fields are unchanged.                                           |
| No-show consequence application/source/correction FKs and command-receipt application FK                    | Existing ON DELETE RESTRICT / ON UPDATE NO ACTION, now explicit in Prisma. IDs are immutable; no cascade-update change is intended.                                                       |
| Activity visibility index                                                                                   | Preserve the existing PostgreSQL index name using Prisma `map`; no rename/rebuild is necessary.                                                                                           |
| Password reset token UUID                                                                                   | Preserve existing database `gen_random_uuid()` default with `dbgenerated`. Other `uuid()` client defaults remain unchanged; do not add database UUID defaults indiscriminately.           |

The empty diff does not validate custom invariants. Migration SQL and PostgreSQL
tests remain authoritative for: schedule/timezone/deadline checks; same-workflow
composite ownership; single pending/current commitments; provider initiation;
LEGACY reconciliation and irreversible cutover; immutable proposals, command
receipts, outcomes and interest; outcome correction and interest consistency;
workflow revision/version locking; consideration ordering and no-show attribution;
outbox scope; and notification target/retention constraints. Prisma cannot fully
represent these CHECKs, functions, partial indexes or deferred constraint triggers.

## Migration execution and recovery

Historical files intentionally mix explicit BEGIN/COMMIT with unwrapped DDL.
Enum additions are separated from later use where PostgreSQL requires a committed
enum value. The complete chain replays successfully in order. Do not wrap all
migrations into one global transaction, concatenate files or rewrite old files
for formatting consistency. No concrete deployment fault requires a new migration.

Use the migration runner and inspect its ledger/catalog after a failure. Do not
assume an unwrapped historical migration is atomic in every runner. Before
manually resolving a failed migration, identify committed statements and repair
or revert them on a rehearsed copy; never merely mark it applied. Transactional
backfills/index builds can still hold locks and need production-volume rehearsal.

No destructive rollback is supplied. Before activation, roll back compatible
application code while retaining additive schema. After CURRENT writes or new
outbox events exist, preserve all history, receipts, inbox read state and queued
events; use forward repair. Do not downgrade CURRENT to LEGACY or revive expired/
closed appointments. A pre-redesign binary is not a safe consumer for new scoped
events. Stop mutation/dispatch traffic if no compatible rollback binary exists.

## Deployment ordering and explicit configuration

1. Review/back up the production migration ledger; rehearse on a representative
   copy. Stop old dispatchers and avoid mixed-version domain mutation traffic.
2. Apply migrations first. Do not start new API/worker code against an old schema.
3. Roll out one compatible API instance, then verify schema readiness and health
   before enabling expiry/dispatch traffic. When staging code with expiry disabled,
   explicitly set `VIEWING_EXPIRY_ENABLED=false` until readiness is established.
4. Set production values explicitly:

```dotenv
VIEWING_EXPIRY_ENABLED=true
VIEWING_EXPIRY_INTERVAL_MS=30000
VIEWING_EXPIRY_BATCH_SIZE=50
```

Defaults remain enabled outside NODE_ENV=test, 30 seconds after each completed
batch, batch size 50. Schema-first deployment is therefore mandatory even when
the flag is omitted. Expiry is database-authoritative and retry-safe; fair sweeps
recover overdue targets. HTTP enforces deadlines while persistence is delayed.
Monitor oldest overdue deadline, expiry errors, transaction duration and outbox
backlog. See [expiry operations](viewing-workflow-expiry.md).

Connected delivery additionally needs `REALTIME_ENABLED=true` and
`OUTBOX_DISPATCH_ENABLED=true`. Offline inbox creation does not depend on dispatch.
Notification retention runs outside tests; expired rows are hidden immediately
even if deletion is delayed. See [notification contract](viewing-workflow-notifications.md).

LEGACY snapshots require locked reconciliation before CURRENT commands become
authoritative. Legacy mutation routes reject CURRENT workflows. Termination closes
commitments and unanswered interest; restore never revives either. Restored ACTIVE
needs a new provider invitation; WAITING privacy remains intact. Retain legacy
routes until frontend migration and remaining legacy use have been verified.

Frontend rollout must wire HTTP commands/read models, typed history targets,
category-filtered bell reads, separate message counts and attention, all scoped
invalidation hints, nextRevalidateAt, and reconnect/focus refetch. Sockets are
invalidation only; historical notifications never authorize a stale action.

## Explicit follow-ups

- Shared realtime fanout and cross-instance session revocation before API replica
  #2. Database claims, sticky sessions or an adapter alone do not replace local
  authorization-aware delivery on every instance.
- Viewing reminders (potential 24h/2h) and provider decision reminders after interest.
- Large-file refactors and shared E2E harness cleanup.
- Legacy endpoint deprecation after verified frontend migration.
- Presence, external calendar, email/push and document realtime/notification
  expansion. DOCUMENTS is a category contract, not activation of document inbox events.

No backend implementation blocker was identified by this schema/contract review.
The separately approved final regression and production-volume/ledger checks
remain outstanding; this phase does not claim production deployment readiness.

## Phase D files

- `src/notifications/notification-category.ts` (new derived category contract).
- `src/notifications/notification-category.spec.ts` (new mapping/filter validation tests).
- `src/notifications/notification.dto.ts` (optional validated filter).
- `src/notifications/notification.service.ts` (derived response field and filtered pagination).
- `test/notifications.e2e-spec.ts` (HTTP category contract coverage).
- `prisma/schema.prisma` (metadata alignment only).
- Documentation: `docs/viewing-workflow-rollout.md`,
  `docs/viewing-workflow-notifications.md`, `docs/viewing-workflow-redesign.md`,
  `docs/viewing-workflow-model.md`, `docs/viewing-workflow-commands.md`,
  `docs/viewing-workflow-lifecycle.md`, `docs/viewing-workflow-read-models.md`,
  `docs/viewing-workflow-realtime.md`, `docs/application-viewings.md`,
  `docs/outbox-foundation.md`.

No migration file or notification-producing policy changed in Phase D.
