import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationStatus, ListingStatus } from '../generated/prisma/enums';

export type ViewingAudience = 'provider' | 'applicant';
const applicationSelect = {
  id: true,
  listingId: true,
  applicantId: true,
  status: true,
  activeAt: true,
  listing: { select: { providerId: true, status: true } },
} satisfies Prisma.ApplicationSelect;
export type ViewingApplication = Prisma.ApplicationGetPayload<{
  select: typeof applicationSelect;
}>;

@Injectable()
export class ApplicationViewingAccessService {
  async authorize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ViewingAudience,
  ): Promise<ViewingApplication> {
    const application = await tx.application.findUnique({
      where: { id: applicationId },
      select: applicationSelect,
    });
    if (
      !application ||
      !(side === 'applicant'
        ? application.applicantId === userId
        : application.listing.providerId === userId &&
          application.status !== ApplicationStatus.WAITING &&
          (application.status === ApplicationStatus.ACTIVE ||
            application.activeAt !== null))
    )
      throw new NotFoundException('Application not found');
    return application;
  }

  canMutate(application: ViewingApplication): boolean {
    return (
      application.status === ApplicationStatus.ACTIVE &&
      (application.listing.status === ListingStatus.PUBLISHED ||
        application.listing.status === ListingStatus.PAUSED)
    );
  }

  async mutation(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ViewingAudience,
  ): Promise<ViewingApplication> {
    const reference = await this.authorize(tx, applicationId, userId, side);
    await tx.$queryRaw`SELECT id FROM listings WHERE id = ${reference.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
    const current = await this.authorize(tx, applicationId, userId, side);
    if (!this.canMutate(current))
      throw new ConflictException(
        'Viewings cannot be changed for this application',
      );
    return current;
  }
}
