import {
  ProviderListingAccess,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationDocumentAccessService } from './application-document-access.service';

@Injectable()
export class VerificationSubjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: ProviderListingAccess,
    private readonly access: ApplicationDocumentAccessService,
  ) {}

  // Domain entry point only. No Phase 3 subject-management HTTP API is exposed.
  householdMember(
    applicationId: string,
    actor: ProviderActor,
    subjectKey: string,
    displayLabel?: string,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        subjectKey,
      )
    )
      throw new BadRequestException('A stable UUID subject key is required');
    const label =
      displayLabel?.normalize('NFKC').trim().replace(/\s+/gu, ' ') ?? null;
    if (
      label !== null &&
      (!label.length || label.length > 100 || /[\p{Cc}<>]/u.test(label))
    )
      throw new BadRequestException('Invalid subject label');
    return this.provider.mutateApplication(
      actor,
      'verification.write',
      applicationId,
      async (tx) => {
        const actorUserId = actor.authority.userId;
        await this.access.mutation(tx, applicationId, actorUserId, 'provider');
        const key = subjectKey.toLowerCase();
        const existing = await tx.applicationVerificationSubject.findUnique({
          where: {
            applicationId_subjectKey: { applicationId, subjectKey: key },
          },
        });
        if (existing) {
          if (
            existing.kind !== 'HOUSEHOLD_MEMBER' ||
            existing.displayLabel !== label
          )
            throw new ConflictException(
              'Subject identity already exists with different metadata',
            );
          return existing;
        }
        return tx.applicationVerificationSubject.create({
          data: {
            applicationId,
            subjectKey: key,
            kind: 'HOUSEHOLD_MEMBER',
            displayLabel: label,
            createdByUserId: actorUserId,
          },
        });
      },
    );
  }

  async resolve(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
    subjectId?: string,
  ) {
    if (subjectId) {
      const subject = await tx.applicationVerificationSubject.findFirst({
        where: { id: subjectId, applicationId },
      });
      if (!subject)
        throw new NotFoundException('Verification subject not found');
      return subject;
    }
    const existing = await tx.applicationVerificationSubject.findUnique({
      where: {
        applicationId_subjectKey: { applicationId, subjectKey: 'applicant' },
      },
    });
    return (
      existing ??
      tx.applicationVerificationSubject.create({
        data: {
          applicationId,
          kind: 'APPLICANT',
          subjectKey: 'applicant',
          createdByUserId: actorUserId,
        },
      })
    );
  }
}
