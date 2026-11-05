import type { Prisma } from '../generated/prisma/client';
import {
  applicationProcessAllowsMutation,
  type ApplicationProcessState,
} from '../applications/application-process.policy';

const subjectSelect = { id: true, kind: true, displayLabel: true } as const;
type SafeSubject = Prisma.ApplicationVerificationSubjectGetPayload<{
  select: typeof subjectSelect;
}>;

export const verificationIdentitySelect = {
  subjectId: true,
  lifecycleState: true,
  revision: true,
  round: true,
  predecessorId: true,
  createdScopeRevision: true,
  closedScopeRevision: true,
  provenance: true,
} satisfies Prisma.ApplicationDocumentRequestSelect;

export type VerificationIdentity = Prisma.ApplicationDocumentRequestGetPayload<{
  select: typeof verificationIdentitySelect;
}> & { subject: SafeSubject; successor: { id: string } | null };

/** Keep relation reads sequential on the transaction's single PostgreSQL connection. */
export async function loadVerificationIdentities<
  T extends { id: string; subjectId: string },
>(
  tx: Prisma.TransactionClient,
  rows: T[],
): Promise<(T & { subject: SafeSubject; successor: { id: string } | null })[]> {
  if (!rows.length) return [];
  const subjects = await tx.applicationVerificationSubject.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.subjectId))] } },
    select: subjectSelect,
  });
  const successors = await tx.applicationDocumentRequest.findMany({
    where: { predecessorId: { in: rows.map((row) => row.id) } },
    select: { id: true, predecessorId: true },
  });
  const bySubject = new Map(subjects.map((subject) => [subject.id, subject]));
  const byPredecessor = new Map(
    successors.map((row) => [row.predecessorId, { id: row.id }]),
  );
  return rows.map((row) => {
    const subject = bySubject.get(row.subjectId);
    if (!subject) throw new Error('Missing verification subject');
    return { ...row, subject, successor: byPredecessor.get(row.id) ?? null };
  });
}

export function verificationIdentity(row: VerificationIdentity) {
  return {
    subject: row.subject,
    lifecycleState: row.lifecycleState,
    revision: row.revision,
    round: row.round,
    predecessorId: row.predecessorId,
    successorId: row.successor?.id ?? null,
    createdScopeRevision: row.createdScopeRevision,
    closedScopeRevision: row.closedScopeRevision,
    provenance: row.provenance,
  };
}

export function verificationFreeze(application: ApplicationProcessState) {
  if (applicationProcessAllowsMutation(application))
    return { isFrozen: false, reason: null } as const;
  const reason =
    application.listing.status === 'RENTED'
      ? 'LISTING_RENTED'
      : application.status !== 'ACTIVE'
        ? 'APPLICATION_NOT_ACTIVE'
        : 'LISTING_UNAVAILABLE';
  return { isFrozen: true, reason } as const;
}
