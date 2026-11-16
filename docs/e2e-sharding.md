# E2E CI sharding

The E2E workflow runs two Jest file-level shards. Each matrix job has its own
runner and PostgreSQL service, with a disposable database named `renyqo_e2e`.
Database setup, migrations, restricted-role provisioning and teardown remain
unchanged. Each shard runs serially with `--runInBand`; concurrency tests retain
their existing internal transaction coordination.

Do not run the two shards concurrently against one local PostgreSQL database.
Shared cleanup can terminate peer connections, and PostgreSQL roles are
cluster-wide, so separate schemas are not sufficient isolation.

Before execution, `scripts/e2e-shards.cjs discover` compares full Jest discovery
with both shard lists. It rejects empty, incomplete or overlapping partitions.
The execution commands are:

```sh
npm run test:e2e -- --runInBand --shard=1/2 --passWithNoTests=false --json --outputFile="$RUNNER_TEMP/e2e-results.json"
npm run test:e2e -- --runInBand --shard=2/2 --passWithNoTests=false --json --outputFile="$RUNNER_TEMP/e2e-results.json"
```

After execution, the helper checks the actual result files against discovery and
rejects missing, duplicate, skipped, TODO or unsuccessful tests/suites. Temporary
JSON stays on the runner; no result artifacts are uploaded. The console and job
summary show suite/test counts, Jest elapsed time and the five slowest suites.
GitHub's job/step durations include setup and provide the overall timing comparison.

Matrix fail-fast is disabled so one failed shard does not cancel its peer. The
final `e2e-tests` required check succeeds only when the entire matrix succeeds;
failed, cancelled or skipped matrix execution cannot pass that gate. The rollout
retains the 25-minute job timeout.

Helper regression checks: `node --test scripts/e2e-shards.test.cjs`.
