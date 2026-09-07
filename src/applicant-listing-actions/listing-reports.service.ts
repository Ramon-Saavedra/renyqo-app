import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { ListingReport } from '../generated/prisma/client';
import { ListingReportReason } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import type { ReportListingDto } from './dto/report-listing.dto';

const REPORT_DETAIL_MAX_LENGTH = 500;

@Injectable()
export class ListingReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publishedListingsService: PublishedListingsService,
  ) {}

  async report(
    applicantId: string,
    listingId: string,
    dto: ReportListingDto,
  ): Promise<ListingReport> {
    await this.publishedListingsService.findPublishedListingOrThrow(listingId);

    const detail = this.normalizeDetail(dto.detail);
    this.assertReasonDetail(dto.reason, detail);

    try {
      return await this.prisma.listingReport.create({
        data: {
          reporterApplicantId: applicantId,
          listingId,
          reason: dto.reason,
          detail,
        },
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('You have already reported this listing');
      }

      throw error;
    }
  }

  private normalizeDetail(detail: string | undefined): string | null {
    if (detail === undefined) {
      return null;
    }

    const trimmed = detail.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.length > REPORT_DETAIL_MAX_LENGTH) {
      throw new BadRequestException(
        `detail must be at most ${REPORT_DETAIL_MAX_LENGTH} characters`,
      );
    }

    return trimmed;
  }

  private assertReasonDetail(
    reason: ListingReportReason,
    detail: string | null,
  ): void {
    if (reason === ListingReportReason.OTHER && detail === null) {
      throw new BadRequestException('detail is required when reason is OTHER');
    }
  }
}
