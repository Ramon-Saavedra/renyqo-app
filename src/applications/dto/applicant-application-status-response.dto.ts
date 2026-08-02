import type { Application } from '../../generated/prisma/client';
import type { ApplicationRejectionReason } from '../../generated/prisma/enums';

export class ApplicantApplicationStatusResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly status: Application['status'];
  readonly rejectedAt: Date | null;
  readonly publicReason: ApplicationRejectionReason | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(application: Application) {
    this.id = application.id;
    this.listingId = application.listingId;
    this.status = application.status;
    this.rejectedAt = application.rejectedAt;
    this.publicReason = application.publicReason;
    this.createdAt = application.createdAt;
    this.updatedAt = application.updatedAt;
  }
}
