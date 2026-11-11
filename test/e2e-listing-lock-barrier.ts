import type { Pool } from 'pg';
import type { Prisma } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';

type WorkspaceDb =
  PrismaService | import('../src/generated/prisma/client').PrismaClient;

const lockWaitActivitySql = `SELECT count(*)::int AS n
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND wait_event_type = 'Lock'
    AND state = 'active'
    AND (
      query LIKE '%listings%'
      OR query LIKE '%lock_workspace_ownership_revision%'
    )`;

async function countActiveLockWaits(prisma: WorkspaceDb, admin?: Pool) {
  if (admin) {
    const result = await admin.query<{ n: number }>(lockWaitActivitySql);
    return result.rows[0]?.n ?? 0;
  }
  const rows =
    await prisma.$queryRawUnsafe<{ n: number }[]>(lockWaitActivitySql);
  return rows[0]?.n ?? 0;
}

async function countListingLockWaiters(prisma: WorkspaceDb, admin?: Pool) {
  const sql = `SELECT count(*)::int AS n
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE c.relname = 'listings'
      AND NOT l.granted
      AND a.datname = current_database()`;
  if (admin) {
    const result = await admin.query<{ n: number }>(sql);
    return result.rows[0]?.n ?? 0;
  }
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE c.relname = 'listings'
      AND NOT l.granted
      AND a.datname = current_database()`;
  return rows[0]?.n ?? 0;
}

export async function waitForListingLockContention(
  prisma: WorkspaceDb,
  admin?: Pool,
  deadlineMs = 15_000,
) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if ((await countActiveLockWaits(prisma, admin)) > 0) return;
    if ((await countListingLockWaiters(prisma, admin)) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    'Competing operation did not reach a PostgreSQL listing/workspace lock wait',
  );
}

type Runner = (
  operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
  options?: {
    isolationLevel?: Prisma.TransactionIsolationLevel;
    maxWait?: number;
    timeout?: number;
  },
) => Promise<unknown>;

/** Holds a listing row lock on a dedicated connection (no open app transaction). */
export async function holdListingRowLockExternal(
  prisma: WorkspaceDb,
  pool: Pool,
  listingId: string,
  admin?: Pool,
) {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    select: { workspaceId: true },
  });
  const client = await pool.connect();
  let released = false;
  const releaseClient = async () => {
    if (released) return;
    released = true;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  };
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [
    listing.workspaceId,
  ]);
  await client.query(
    `SELECT id FROM listings WHERE workspace_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
    [listing.workspaceId, listingId],
  );
  return {
    locked: Promise.resolve(),
    release: () => {
      void releaseClient();
    },
    spy: { mockRestore: () => {} },
    attempts: () => 2,
    async waitForDatabaseWaiter() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if ((await countActiveLockWaits(prisma, admin)) > 0) return;
        if ((await countListingLockWaiters(prisma, admin)) > 0) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error(
        'Competing operation did not wait on the PostgreSQL listing lock',
      );
    },
  };
}

/** Synchronizes on the real listing row FOR UPDATE used by provider/applicant transactions. */
export function holdFirstListingLock(
  prisma: WorkspaceDb,
  listingId: string,
  admin?: Pool,
) {
  const run = prisma.$transaction.bind(prisma) as Runner;
  let acquired!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const holdsListingRowLock = (
    sql: TemplateStringsArray | Prisma.Sql,
    values: unknown[],
  ) => {
    const text = Array.isArray(sql) ? sql.join('') : '';
    return (
      values.some(
        (value) => value === listingId || String(value) === listingId,
      ) ||
      (text.includes('listings') &&
        values.some((value) => String(value) === listingId))
    );
  };
  const spy = jest
    .spyOn(prisma, '$transaction')
    .mockImplementation(
      (operation: Parameters<Runner>[0], options?: Parameters<Runner>[1]) =>
        run(
          (tx) =>
            operation(
              new Proxy(tx, {
                get(target, property) {
                  if (property === '$queryRaw')
                    return async (
                      sql: TemplateStringsArray | Prisma.Sql,
                      ...values: unknown[]
                    ) => {
                      if (!holdsListingRowLock(sql, values))
                        return target.$queryRaw(sql, ...values);
                      const attempt = ++attempts;
                      const result = await target.$queryRaw(sql, ...values);
                      if (attempt === 1) {
                        acquired();
                        await gate;
                      }
                      return result;
                    };
                  const value: unknown = Reflect.get(target, property);
                  return value;
                },
              }),
            ),
          options,
        ),
    );
  return {
    locked,
    release,
    spy,
    attempts: () => attempts,
    async waitForDatabaseWaiter() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if ((await countActiveLockWaits(prisma, admin)) > 0) return;
        if ((await countListingLockWaiters(prisma, admin)) > 0) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error(
        'Competing operation did not wait on the PostgreSQL listing lock',
      );
    },
  };
}
