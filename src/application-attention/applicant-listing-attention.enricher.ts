import { Injectable, NotFoundException } from '@nestjs/common';
import type { BlockingApplicationState } from '../applications/applicant-listing-application-state';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import { ApplicantListingAttentionDto } from './dto/attention-response.dto';

@Injectable()
export class ApplicantListingAttentionEnricher {
  constructor(private readonly attention: ApplicationAttentionQueryService) {}

  async forApplications(
    applicantId: string,
    blockingByListingId: ReadonlyMap<string, BlockingApplicationState>,
  ): Promise<ReadonlyMap<string, ApplicantListingAttentionDto>> {
    const applicationIdByListingId = new Map(
      [...blockingByListingId].map(([listingId, blocking]) => [
        listingId,
        blocking.id,
      ]),
    );
    const applicationIds = [...new Set(applicationIdByListingId.values())];
    if (!applicationIds.length) return new Map();
    const batch = await this.attention.batch(
      applicantId,
      'applicant',
      applicationIds,
    );
    const items = new Map(
      batch.items.map((item) => [item.applicationId, item]),
    );
    const attention = new Map<string, ApplicantListingAttentionDto>();
    for (const [listingId, applicationId] of applicationIdByListingId) {
      const item = items.get(applicationId);
      if (!item) throw new NotFoundException('Application not found');
      attention.set(
        listingId,
        new ApplicantListingAttentionDto(applicationId, item),
      );
    }
    return attention;
  }
}
