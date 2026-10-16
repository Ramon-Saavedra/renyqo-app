import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApplicationStatus } from '../generated/prisma/enums';
import { ApplicantListingAttentionEnricher } from './applicant-listing-attention.enricher';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import {
  ApplicationAttentionListItemDto,
  ApplicationAttentionSummaryDto,
  AttentionCategoryTotalsDto,
} from './dto/attention-response.dto';

describe('ApplicantListingAttentionEnricher', () => {
  const summary = new ApplicationAttentionSummaryDto(
    0,
    0,
    new AttentionCategoryTotalsDto(0, 0, 0),
    [],
    [],
    null,
  );

  function item(applicationId: string, listingId: string) {
    return new ApplicationAttentionListItemDto(
      applicationId,
      listingId,
      summary,
    );
  }

  const selected = {
    id: 'selected',
    status: ApplicationStatus.ACTIVE,
    publicReason: null,
  } as const;

  it('batches the already selected blocking applications once', async () => {
    const batch = jest.fn().mockResolvedValue({
      items: [item('selected', 'listing-a'), item('other', 'listing-b')],
    });
    const module = await Test.createTestingModule({
      providers: [
        ApplicantListingAttentionEnricher,
        { provide: ApplicationAttentionQueryService, useValue: { batch } },
      ],
    }).compile();

    const result = await module
      .get(ApplicantListingAttentionEnricher)
      .forApplications(
        'applicant',
        new Map([
          ['listing-a', selected],
          ['listing-b', { ...selected, id: 'other' }],
        ]),
      );

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith('applicant', 'applicant', [
      'selected',
      'other',
    ]);
    expect(result.get('listing-a')?.applicationId).toBe('selected');
    expect(result.get('listing-b')?.applicationId).toBe('other');
  });

  it('does not query attention when no blocking application was selected', async () => {
    const batch = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        ApplicantListingAttentionEnricher,
        { provide: ApplicationAttentionQueryService, useValue: { batch } },
      ],
    }).compile();

    await expect(
      module
        .get(ApplicantListingAttentionEnricher)
        .forApplications('applicant', new Map()),
    ).resolves.toEqual(new Map());
    expect(batch).not.toHaveBeenCalled();
  });

  it('fails closed when a selected application is missing from the batch', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ApplicantListingAttentionEnricher,
        {
          provide: ApplicationAttentionQueryService,
          useValue: { batch: jest.fn().mockResolvedValue({ items: [] }) },
        },
      ],
    }).compile();

    await expect(
      module
        .get(ApplicantListingAttentionEnricher)
        .forApplications('applicant', new Map([['listing', selected]])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
