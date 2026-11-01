import type { PrismaClient } from '../src/generated/prisma/client';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

/** Test-only reset of the complete FK graph, including immutable history.
 * TRUNCATE does not invoke row DELETE triggers; no production constraint is disabled.
 * Suites using this helper must run serially against a disposable E2E database.
 */
export async function clearE2EData(prisma: PrismaClient): Promise<void> {
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
      if (attempt >= 2 || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
