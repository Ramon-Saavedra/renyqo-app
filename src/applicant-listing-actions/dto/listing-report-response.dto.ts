import type { ListingReport } from '../../generated/prisma/client';
import { ListingReportReason } from '../../generated/prisma/enums';

export class ListingReportResponseDto {
  readonly id!: string;
  readonly listingId!: string;
  readonly reason!: ListingReportReason;
  readonly createdAt!: Date;

  constructor(report: ListingReport) {
    this.id = report.id;
    this.listingId = report.listingId;
    this.reason = report.reason;
    this.createdAt = report.createdAt;
  }
}
