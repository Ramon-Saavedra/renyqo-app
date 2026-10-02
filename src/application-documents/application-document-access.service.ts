import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationStatus, ListingStatus } from '../generated/prisma/enums';

export type DocumentAudience = 'provider' | 'applicant';

const applicationSelect = {
  id: true,
  listingId: true,
  applicantId: true,
  status: true,
  activeAt: true,
  listing: { select: { providerId: true, status: true } },
} satisfies Prisma.ApplicationSelect;

export type DocumentApplication = Prisma.ApplicationGetPayload<{
  select: typeof applicationSelect;
}>;

@Injectable()
export class ApplicationDocumentAccessService {
  async authorize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    audience: DocumentAudience,
  ): Promise<DocumentApplication> {
    const application = await tx.application.findUnique({
      where: { id: applicationId },
      select: applicationSelect,
    });
    if (
      !application ||
      !(audience === 'applicant'
        ? application.applicantId === userId
        : application.listing.providerId === userId &&
          application.status !== ApplicationStatus.WAITING &&
          (application.status === ApplicationStatus.ACTIVE ||
            application.activeAt !== null))
    )
      throw new NotFoundException('Application not found');
    return application;
  }

  async lock(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ): Promise<DocumentApplication> {
    const reference = await tx.application.findUnique({
      where: { id: applicationId },
      select: applicationSelect,
    });
    if (!reference) throw new NotFoundException('Application not found');
    await tx.$queryRaw`SELECT id FROM listings WHERE id = ${reference.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
    const current = await tx.application.findUnique({
      where: { id: applicationId },
      select: applicationSelect,
    });
    if (!current) throw new NotFoundException('Application not found');
    return current;
  }

  async mutation(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    audience: DocumentAudience,
  ): Promise<DocumentApplication> {
    await this.authorize(tx, applicationId, userId, audience);
    await this.lock(tx, applicationId);
    const application = await this.authorize(
      tx,
      applicationId,
      userId,
      audience,
    );
    if (!this.canMutate(application))
      throw new ConflictException(
        'Documents cannot be changed for this application',
      );
    return application;
  }

  canMutate(application: DocumentApplication): boolean {
    return (
      application.status === ApplicationStatus.ACTIVE &&
      (application.listing.status === ListingStatus.PUBLISHED ||
        application.listing.status === ListingStatus.PAUSED)
    );
  }
}
