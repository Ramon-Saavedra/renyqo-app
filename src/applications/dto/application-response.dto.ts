import type { Application } from '../../generated/prisma/client';

export class ApplicationResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly applicantId: string;
  readonly status: Application['status'];
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(application: Application) {
    this.id = application.id;
    this.listingId = application.listingId;
    this.applicantId = application.applicantId;
    this.status = application.status;
    this.createdAt = application.createdAt;
    this.updatedAt = application.updatedAt;
  }
}
