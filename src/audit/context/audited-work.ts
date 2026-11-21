import type { Prisma } from '../../generated/prisma/client';

// Completion fence for an OPT-IN audited callback inside an existing outer
// transaction. pg COMMIT on an aborted tx can return ROLLBACK without throwing;
// this query makes swallowed SQL failures observable before the adapter commits.
export async function auditedWork<T>(
  tx: Prisma.TransactionClient,
  work: () => Promise<T>,
) {
  const result = await work();
  await tx.$executeRaw`SELECT assert_audit_execution_complete()`;
  return result;
}
