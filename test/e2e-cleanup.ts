import type { PrismaClient } from '../src/generated/prisma/client';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

const SHARED_EMPTY_CHECKS: readonly (keyof PrismaClient)[] = [
  'application',
  'applicationEligibilityAssessment',
  'applicationEligibilityCheck',
  'applicationConversation',
  'applicationDocumentFile',
  'applicationDocumentRequest',
  'applicationViewing',
  'listing',
  'listingCriteriaRevision',
  'notification',
  'outboxEvent',
  'sessionAuthGrant',
  'user',
  'userSession',
  'workspaceMembership',
  'providerWorkspace',
] as const;

function assertCleanupAllowed(): string {
  const expected = process.env['E2E_DATABASE_URL'];
  const active = process.env['DATABASE_URL'];
  if (
    !expected ||
    active !== expected ||
    process.env['NODE_ENV'] !== 'test' ||
    process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
  ) {
    throw new Error(
      'Unsafe E2E cleanup: dedicated database, matching URLs and reset marker required',
    );
  }
  assertSafeE2EDatabaseUrl(expected);
  return expected;
}

async function terminatePeerBackends(
  tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  mode: 'idle' | 'all',
) {
  if (mode === 'all') {
    await tx.$executeRaw`
      SELECT pg_terminate_backend(a.pid)
      FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND a.backend_type = 'client backend'`;
    return;
  }
  await tx.$executeRaw`
    SELECT pg_terminate_backend(a.pid)
    FROM pg_stat_activity a
    WHERE a.datname = current_database()
      AND a.pid <> pg_backend_pid()
      AND a.backend_type = 'client backend'
      AND (
        a.state = 'idle in transaction'
        OR (
          a.wait_event_type = 'Lock'
          AND a.query ILIKE '%TRUNCATE%'
        )
      )`;
}

/** Proves the active search_path schema has no shared E2E domain rows left. */
export async function assertE2EDatabaseEmpty(
  prisma: PrismaClient,
): Promise<void> {
  assertCleanupAllowed();
  const violations: string[] = [];
  for (const model of SHARED_EMPTY_CHECKS) {
    const count = await (
      prisma[model] as { count(this: void): Promise<number> }
    ).count();
    if (count !== 0) violations.push(`${String(model)}=${count}`);
  }
  if (violations.length) {
    throw new Error(`E2E cleanup incomplete: ${violations.join(', ')}`);
  }
}

/** Test-only reset of the complete FK graph, including immutable history.
 * TRUNCATE does not invoke row DELETE triggers; no production constraint is disabled.
 * Suites using this helper must run serially against a disposable E2E database.
 */
export async function clearE2EData(prisma: PrismaClient): Promise<void> {
  const expected = assertCleanupAllowed();
  const database = decodeURIComponent(new URL(expected).pathname.slice(1));
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const retryable = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const value = error as Record<string, unknown>;
    return (
      value.code === 'P2034' ||
      value.code === '40P01' ||
      value.code === '40001' ||
      value.originalCode === '40P01' ||
      value.originalCode === '40001' ||
      ['cause', 'meta', 'driverAdapterError'].some((key) =>
        retryable(value[key]),
      )
    );
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        if (attempt > 0) await terminatePeerBackends(tx, 'idle');
        const [target] = await tx.$queryRaw<
          { database: string; schema: string }[]
        >`SELECT current_database() AS database, current_schema() AS schema`;
        if (target?.database !== database || !target.schema)
          throw new Error('Unsafe E2E cleanup connection');
        const tables = await tx.$queryRaw<
          { tablename: string }[]
        >`SELECT tablename FROM pg_tables WHERE schemaname = ${target.schema} AND tablename <> '_prisma_migrations' ORDER BY tablename`;
        if (tables.length) {
          // One statement satisfies cyclic/restrict FKs without CASCADE into other schemas.
          await tx.$executeRawUnsafe(
            `TRUNCATE TABLE ${tables.map((t) => `${quote(target.schema)}.${quote(t.tablename)}`).join(', ')}`,
          );
        }
      });
      return;
    } catch (error) {
      // A failed concurrency assertion may leave a competing request finishing.
      // Rollback and retry only PostgreSQL lock/serialization conflicts, never constraints.
      if (attempt >= 9 || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

export async function drainE2EPeerBackends(
  prisma: PrismaClient,
): Promise<void> {
  assertCleanupAllowed();
  await prisma.$transaction(async (tx) => terminatePeerBackends(tx, 'all'));
}

/** Runs after shared-DB suite files when nested apps may leave peer pool connections open. */
export async function finalizeSharedE2ESuite(
  prisma: PrismaClient,
): Promise<void> {
  const expected = assertCleanupAllowed();
  const database = decodeURIComponent(new URL(expected).pathname.slice(1));
  await prisma.$transaction(async (tx) => {
    const [target] = await tx.$queryRaw<
      { database: string; schema: string }[]
    >`SELECT current_database() AS database, current_schema() AS schema`;
    if (target?.database !== database || target?.schema !== 'public') return;
    await terminatePeerBackends(tx, 'all');
  });
  await clearE2EData(prisma);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await assertE2EDatabaseEmpty(prisma);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await prisma.$transaction(async (tx) => terminatePeerBackends(tx, 'all'));
      await clearE2EData(prisma);
    }
  }
}
