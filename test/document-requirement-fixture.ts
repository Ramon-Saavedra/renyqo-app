import { randomUUID } from 'node:crypto';
import { ApplicationDocumentState } from '../src/generated/prisma/enums';
import type { PrismaClient, Prisma } from '../src/generated/prisma/client';
import { requirementDefinition } from '../src/application-documents/verification-requirement.policy';

/** Explicit current-domain database fixture. Historical imports are tested before migration. */
export async function createDocumentRequirementFixture(
  prisma: PrismaClient,
  input: {
    data: Omit<
      Prisma.ApplicationDocumentRequestUncheckedCreateInput,
      'subjectId'
    >;
  },
) {
  const data = input.data;
  return prisma.$transaction(async (tx) => {
    const reference = await tx.application.findUniqueOrThrow({
      where: { id: data.applicationId },
      include: { listing: true },
    });
    await tx.$queryRaw`SELECT id FROM listings WHERE id=${reference.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${reference.id}::uuid FOR UPDATE`;
    const actor = (
      await tx.workspaceMembership.findUniqueOrThrow({
        where: { id: reference.listing.responsibleMembershipId },
        select: { userId: true },
      })
    ).userId;
    const subjectKey = /^[0-9a-f-]{36}$/i.test(data.definitionKey)
      ? data.definitionKey.toLowerCase()
      : 'applicant';
    let subject = await tx.applicationVerificationSubject.findUnique({
      where: {
        applicationId_subjectKey: { applicationId: reference.id, subjectKey },
      },
    });
    subject ??= await tx.applicationVerificationSubject.create({
      data: {
        id: randomUUID(),
        applicationId: reference.id,
        subjectKey,
        kind: subjectKey === 'applicant' ? 'APPLICANT' : 'HOUSEHOLD_MEMBER',
        createdByUserId: actor,
      },
    });
    const scope = await tx.application.update({
      where: { id: reference.id },
      data: { verificationScopeRevision: { increment: 1 } },
      select: { verificationScopeRevision: true },
    });
    const definition = requirementDefinition({
      type: data.type,
      customLabel: data.customLabel ?? undefined,
    });
    return tx.applicationDocumentRequest.create({
      data: {
        ...data,
        ...definition,
        subjectId: subject.id,
        createdByUserId: actor,
        createdScopeRevision: scope.verificationScopeRevision,
      },
    });
  });
}

/** Read-side fixture with optional persisted evidence; no upload/scan behavior is simulated. */
export async function createDocumentEvidenceFixture(
  prisma: PrismaClient,
  input: Parameters<typeof createDocumentRequirementFixture>[1] & {
    state?: ApplicationDocumentState;
    now: Date;
    bucket: string;
  },
) {
  const request = await createDocumentRequirementFixture(prisma, input);
  if (!input.state) return { request, file: null };
  const file = await prisma.applicationDocumentFile.create({
    data: {
      requestId: request.id,
      storageKey: randomUUID(),
      bucket: input.bucket,
      checksum: 'a'.repeat(64),
      mimeType: 'application/pdf',
      size: 100,
      state: input.state,
      recoverAfter: input.now,
      expiresAt: new Date(input.now.getTime() + 60000),
      availableAt:
        input.state === ApplicationDocumentState.AVAILABLE ? input.now : null,
    },
  });
  const current = await prisma.applicationDocumentRequest.update({
    where: { id: request.id },
    data: { currentFileId: file.id },
  });
  return { request: current, file };
}

/** Assert the operation preserves every persisted evidence field. */
export async function expectDocumentEvidencePreserved(
  prisma: PrismaClient,
  fileId: string,
  operation: () => PromiseLike<unknown>,
): Promise<void> {
  const before = await prisma.applicationDocumentFile.findUniqueOrThrow({
    where: { id: fileId },
  });
  await operation();
  expect(
    await prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: fileId },
    }),
  ).toEqual(before);
}
