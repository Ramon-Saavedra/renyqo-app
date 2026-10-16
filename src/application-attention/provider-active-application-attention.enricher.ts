import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import { compactAttentionSummary } from './attention-projection';
import { ApplicationAttentionSummaryDto } from './dto/attention-response.dto';

@Injectable()
export class ProviderActiveApplicationAttentionEnricher {
  constructor(private readonly attention: ApplicationAttentionQueryService) {}

  async forApplications(
    providerId: string,
    applicationIds: readonly string[],
  ): Promise<ReadonlyMap<string, ApplicationAttentionSummaryDto>> {
    const ids = [...new Set(applicationIds)];
    if (!ids.length) return new Map();
    const batch = await this.attention.batch(providerId, 'provider', ids);
    const summaries = new Map(
      batch.items.map((item) => [
        item.applicationId,
        compactAttentionSummary(item),
      ]),
    );
    if (summaries.size !== ids.length)
      throw new NotFoundException('Application not found');
    return summaries;
  }
}
