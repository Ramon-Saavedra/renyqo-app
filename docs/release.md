# Backend release

This is the operational procedure for releasing the backend. It does not choose a
host, a registry, or an AWS deployment. Application behavior, health checks, and
migration SQL stay as they are.

PostgreSQL 16 and the checked-in migration chain are authoritative. Apply that
chain with `npx prisma migrate deploy`. Do not use `prisma migrate dev`,
`db push`, or a regenerated diff against a database that already has history.
Local development setup remains in [Database](database.md).

## Related documentation

- [Database](database.md) for the queue write-stop, household cleanup, and local setup.
- [Viewing workflow rollout](viewing-workflow-rollout.md) for schema-first activation, ledger repair, and forward repair after current workflow writes.
- [Viewing expiry](viewing-workflow-expiry.md) for the expiry scheduler that runs inside the API process.
- [Outbox foundation](outbox-foundation.md) for dispatch defaults and single-instance delivery.
- [Realtime security](realtime-security.md) for transport flags and the one-instance boundary.
- [Application documents](application-documents.md) for the document worker and the AWS prerequisites that are outside this procedure.

## Artifact and environments

Build one API image from the release git revision and promote that digest from
staging to production. Staging and production both use `NODE_ENV=production`,
Node 22, the same image digest, the same migration history, and
`node dist/main`.

These values may differ by environment: `DATABASE_URL`, `SESSION_SECRET`,
`FRONTEND_URL`, Cloudinary, OpenAI, and the expiry, realtime, and dispatch
flags below. Secrets and origins never move from staging into production by
copying an env file wholesale. `NODE_ENV=production` marks the session cookie
`secure`, so both environments need HTTPS.

`NODE_ENV=test` belongs to CI. It disables viewing expiry, notification
retention, and outbox retention, and it is not a staging setting.

## One API instance

Run one API process. Socket.IO admission, connection limits, and session
revocation live in that process. Outbox dispatch is one loop in that process.
AI and other in-memory limits are per process. A second API replica is not a
supported release shape. See [Realtime security](realtime-security.md) and
[Outbox foundation](outbox-foundation.md).

Replace that process. Do not leave the previous API running beside the new one
unless the migration safety rule below classifies the migration as safe for
overlap. Viewing expiry, notification retention, and outbox retention are API
schedulers, not the document worker.

The document worker is a separate process from the same image:
`node dist/application-documents/worker/main`. More than one document worker is
safe. More than one API process is not.

## Operational checklist

Confirm each item before the next one. A failed item stops the release.

- Confirm the target image digest and the git revision it was built from. Staging and production use that digest.
- Rehearse `npx prisma migrate deploy` on staging, or on a restored copy of the production database. Inspect `_prisma_migrations` after the rehearsal.
- Back up the production database and confirm the backup can be identified for this release.
- Classify the pending migrations with the decision rule below. Record whether they are safe for overlap or require a write-stop.
- Stop the API and domain writes when the rule requires a write-stop. Leave them stopped through migration.
- Run `npx prisma migrate deploy` with `DATABASE_URL` set only in the environment, from the same git revision as the image.
- Abort on any non-zero migration exit. Do not start the API. Do not mark a failed migration applied.
- Start one API process with `VIEWING_EXPIRY_ENABLED=false`, `REALTIME_ENABLED` unset or `false`, and `OUTBOX_DISPATCH_ENABLED` unset or `false`.
- Verify `GET /api/v1/health` returns `200` and `{ "status": "ok" }`.
- Verify `GET /api/v1/ready` returns `200` and `{ "status": "ok" }`. A `503` with `{ "status": "unavailable" }` means this process cannot reach PostgreSQL. Do not send traffic. That response is not a migration or document-worker failure.
- Enable scheduled work, realtime, and dispatch in this order: `VIEWING_EXPIRY_ENABLED=true` with the production interval and batch below; then `REALTIME_ENABLED=true`; then `OUTBOX_DISPATCH_ENABLED=true`. Validate transport on staging before enabling dispatch in production.
- Send traffic only after that readiness check. Enable realtime and dispatch only when this release intends to turn them on.
- Start the document worker only after the AWS prerequisites in [Application documents](application-documents.md) exist. Worker startup does not gate API traffic.

Production expiry settings, after the health check:

```dotenv
VIEWING_EXPIRY_ENABLED=true
VIEWING_EXPIRY_INTERVAL_MS=30000
VIEWING_EXPIRY_BATCH_SIZE=50
```

Outside `NODE_ENV=test`, notification retention and outbox retention of
already-dispatched rows start with the API process. They have no disable flag.
The first boot is therefore not free of database writes. Viewing expiry is the
scheduled domain worker that must stay off until health passes.

## Migration safety decision

Classify every pending migration before applying it to a database that serves
traffic. A migration can match more than one class. The strictest class wins.
The [viewing workflow rollout](viewing-workflow-rollout.md) is the stricter
procedure for that schema: stop mixed-version mutation before those migrations
and repair forward after current workflow or new outbox writes exist.

### Additive and safe for overlap

All of the following are true:

- The change adds tables, nullable columns, indexes, or enum values.
- It does not rename or drop columns, types, or enum values.
- It does not backfill, rewrite, or clear existing rows.
- It does not add a `NOT NULL`, `CHECK`, trigger, or foreign key that existing writers can violate.
- The previous binary still reads and writes the migrated schema correctly.
- The new binary is not started until `migrate deploy` has exited 0.

An old process may keep serving through that migration. New enum values stay
safe for the old binary only until a newer writer inserts them. After those
rows exist, treat the release as incompatible with rollback.

`20261002120000_add_application_conversation` is this class: new tables and
enum values, no backfill.

### Requires Expand & Contract

The desired end state is incompatible with the old binary, and the change can
be split:

1. Expand: additive schema the old binary tolerates.
2. Deploy the new binary and wait until no old writer remains.
3. Contract: drop or tighten the old shape in a later migration.

A single migration that expands and contracts is not safe for overlap. Split it
before it reaches a live database. Do not rewrite a migration that has already
been applied.

`20260922120000_add_listing_display_order` adds the column, backfills it, and
sets `NOT NULL` in one file. That is expand and contract together.

### Requires a write-stop

Stop the API and domain writes for the whole migration window when any pending
migration:

- Rewrites, backfills, or clears existing rows and then adds a constraint.
- Renames an enum value the running binary still writes.
- Drops a column or type the running binary still uses.
- Replaces a `CHECK`, trigger, or not-null rule that in-flight writes can violate.
- Builds or rebuilds indexes as a blocking operation, including the application queue index rebuild.
- Reconciles existing viewing or outbox rows.

Known members of this class include the application queue backfill and index
rebuild, `20260729202915_enforce_applicant_household_counts`, the pets and
smoking column drops, the enum renames below, `display_order`, and the viewing
workflow migrations through `20261025110000_durable_notifications`. Details for
the queue window are in [Database](database.md).

A first apply to an empty database has no writers to stop. The same command and
abort rule still apply.

### Incompatible with rollback to the previous binary

After the migration commits, the previous image is not a rollback target when
any of these are true:

- It would write a renamed or removed enum value. Known renames: `pending_queue` to `waiting`, `prefer_not` to `not_allowed`, and `non_smokers_preferred` to `not_allowed`.
- It depends on a dropped column or type. `20260826130000_simplify_pets_smoking_model` drops `pets_note`, `smoking_status`, and `SmokingStatus`.
- It inserts rows that omit a new `NOT NULL` column, as with `display_order`.
- It writes a shape rejected by a new `CHECK` or trigger, including the household-count check and the replaced `outbox_event_scope`.
- It cannot read rows the new binary has already written, including current viewing workflow rows and new outbox or activity values.

Keep the new schema. Repair with a forward release.

## Failure handling

Inspect `_prisma_migrations` and the migration SQL after every failure. Some
historical files mix explicit transactions with statements that commit on their
own. A failed run can leave committed statements and a failed ledger row.
Identify those statements on a restored copy before any manual repair. Do not
mark the migration applied to hide a partial change.

**Migration fails before the new API starts.** Leave the new image stopped. If
writes were stopped, keep them stopped. Restart the previous image only when
the decision rule says it can still use the schema left behind.

**Migration succeeds and the API deploy fails.** Leave the schema in place.
Start the previous image only when the migration is still compatible with that
binary. Otherwise ship a forward fix from this revision.

**The API process starts and health does not return `200`.** Do not send
traffic. Apply the same compatibility rule to the previous image or a forward
fix.

**The document worker fails while the API is healthy.** Leave the API in
service. Document attempts can remain `PROCESSING`. Restart the worker on its
own after the AWS configuration is corrected.

**An old API process is still running against the new schema.** Stop it before
sending traffic whenever the migration was not classified as safe for overlap.

## Rollback and rollforward

There is no down migration. Schema rollback means restoring the backup taken
for this release, which discards writes made after that backup. Prefer that
only when the release has not been serving traffic.

Roll the application image back, and keep the new schema, only when the
migration was classified as safe for overlap and the new process has not
written rows the previous binary cannot read. Disable
`OUTBOX_DISPATCH_ENABLED` and then `REALTIME_ENABLED` before stopping a process
that had them on. Leave outbox rows in place.

Roll forward when the migration is incompatible with the previous binary, when
new code has written current workflow or new outbox rows, or when the new
process failed and no compatible previous image remains. Stop mutation and
dispatch until that forward image is healthy.

## Document worker

The worker shares the API image and uses a different command. It does not
listen on a port. It validates `DOCUMENTS_S3_BUCKET`,
`DOCUMENTS_AWS_ACCOUNT_ID`, `DOCUMENTS_GUARDDUTY_PLAN_ARN`,
`DOCUMENTS_SCAN_QUEUE_URL`, and `DATABASE_URL` before polling, and it exits
when that configuration is absent. `SIGTERM` and `SIGINT` stop new receives,
drain in-flight work, and close Prisma.

Start it after the API release, only when the bucket, queue, and IAM
prerequisites in [Application documents](application-documents.md) are already
deployed. Do not start it as a substitute for viewing expiry or outbox
dispatch. API routes that need document storage return `503` until their
settings exist; the rest of the API does not.

## Known limitations

These limits are accepted for this preparation phase. Revisit both before a
mature production deployment. This procedure does not change either one.

The dedicated migration image `migrate` target runs as user `migrate` (uid
1001). It still contains the full development dependency tree, because that
stage follows a full `npm ci`. The API image remains the production stage and
does not contain the Prisma CLI. `DATABASE_URL` is supplied only when the
container runs. The CI `--network host` invocation is not a production network
setup.

`GET /api/v1/health` is liveness only. The body is `{ "status": "ok", "timestamp" }`.
It does not query PostgreSQL, the migration ledger, or the document worker.
The process listens after environment validation and the initial Prisma
connection, so a `200` means this process finished boot. It does not prove that
the schema matches the image, that the database is still reachable, or that the
worker is alive.

`GET /api/v1/ready` checks current PostgreSQL connectivity with one `SELECT 1`.
It returns `{ "status": "ok" }` or `{ "status": "unavailable" }`. It does not
read `_prisma_migrations`, application tables, or the document worker. Schema
compatibility remains the migration command's exit code. A timed-out readiness
result does not cancel the underlying database operation; only one such
operation is in flight. Post-deploy verification is the migration exit code,
then liveness, then readiness, before traffic.
