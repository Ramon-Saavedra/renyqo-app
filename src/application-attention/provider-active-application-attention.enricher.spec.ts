import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import {
  ApplicationAttentionListItemDto,
  ApplicationAttentionSummaryDto,
  AttentionCategoryTotalsDto,
  AttentionSection,
  AttentionTargetDto,
} from './dto/attention-response.dto';
import { ProviderActiveApplicationAttentionEnricher } from './provider-active-application-attention.enricher';

describe('ProviderActiveApplicationAttentionEnricher', () => {
  const summary = new ApplicationAttentionSummaryDto(
    1,
    2,
    new AttentionCategoryTotalsDto(0, 1, 0),
    [
      new AttentionTargetDto(
        'application',
        'listing',
        AttentionSection.MESSAGES,
      ),
    ],
    [],
    null,
  );

  it('batches provider attention once and keeps summary fields', async () => {
    const batch = jest.fn().mockResolvedValue({
      items: [
        new ApplicationAttentionListItemDto(
          'first',
          'listing',
          'First listing',
          'Munich',
          summary,
        ),
        new ApplicationAttentionListItemDto(
          'second',
          'listing',
          'Second listing',
          'Hamburg',
          summary,
        ),
      ],
    });
    const module = await Test.createTestingModule({
      providers: [
        ProviderActiveApplicationAttentionEnricher,
        { provide: ApplicationAttentionQueryService, useValue: { batch } },
      ],
    }).compile();

    const result = await module
      .get(ProviderActiveApplicationAttentionEnricher)
      .forApplications('provider', ['first', 'second', 'first']);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith('provider', 'provider', [
      'first',
      'second',
    ]);
    expect(result.get('first')).toMatchObject({
      pendingActionCount: 1,
      actionableUnreadMessageCount: 2,
      categories: { documentReviewCount: 1 },
    });
    expect(result.get('first')).not.toHaveProperty('pendingActions');
  });

  it('does not query an empty active list', async () => {
    const batch = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        ProviderActiveApplicationAttentionEnricher,
        { provide: ApplicationAttentionQueryService, useValue: { batch } },
      ],
    }).compile();

    await expect(
      module
        .get(ProviderActiveApplicationAttentionEnricher)
        .forApplications('provider', []),
    ).resolves.toEqual(new Map());
    expect(batch).not.toHaveBeenCalled();
  });

  it('fails closed when provider scope omits an application', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ProviderActiveApplicationAttentionEnricher,
        {
          provide: ApplicationAttentionQueryService,
          useValue: {
            batch: jest.fn().mockRejectedValue(new NotFoundException()),
          },
        },
      ],
    }).compile();

    await expect(
      module
        .get(ProviderActiveApplicationAttentionEnricher)
        .forApplications('provider', ['waiting-application']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
