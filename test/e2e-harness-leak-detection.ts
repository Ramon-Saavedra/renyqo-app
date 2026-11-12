import type { PrismaClient } from '../src/generated/prisma/client';
import { assertE2EDatabaseEmpty, drainE2EPeerBackends } from './e2e-cleanup';
import { flushProcessWarnings } from './e2e-environment';
import { applyCanonicalSharedE2EProcessEnv } from './e2e-shared-test-env';

async function countPeerBackends(
  prisma: PrismaClient,
): Promise<{ total: number; idleInTransaction: number }> {
  const rows = await prisma.$queryRaw<
    { total: number; idle_in_txn: number }[]
  >`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_txn
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND backend_type = 'client backend'`;
  return {
    total: rows[0]?.total ?? 0,
    idleInTransaction: rows[0]?.idle_in_txn ?? 0,
  };
}

/** Post-suite proof that shared-DB harness left no durable or process-visible residue. */
export async function verifySharedE2EHarnessQuiescent(
  prisma: PrismaClient,
  options: { expectEmptyDatabase?: boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await flushProcessWarnings();
    const { total, idleInTransaction } = await countPeerBackends(prisma);
    if (idleInTransaction === 0) break;
    if (attempt === 4) {
      throw new Error(
        `E2E harness leak: ${idleInTransaction} peer backend(s) idle in transaction (total peers=${total})`,
      );
    }
    await drainE2EPeerBackends(prisma);
  }
  if (options.expectEmptyDatabase !== false) {
    await assertE2EDatabaseEmpty(prisma);
  }
  applyCanonicalSharedE2EProcessEnv();
  if (
    process.env['REALTIME_ENABLED'] !== 'false' ||
    process.env['OUTBOX_DISPATCH_ENABLED'] !== 'false' ||
    process.env['VIEWING_EXPIRY_ENABLED'] !== 'false'
  ) {
    throw new Error(
      'E2E harness leak: canonical feature flags were not restored on process.env',
    );
  }
}
