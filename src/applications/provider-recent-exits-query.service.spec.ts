import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { EligibilityResponseDto } from '../eligibility/dto/eligibility-response.dto';
import {
  ApplicationStatus,
  ApplicationRejectionReason,
  ListingStatus,
} from '../generated/prisma/enums';
import { ApplicationAdmissionService } from './application-admission.service';
import { ApplicationLifecycleReadService } from './application-lifecycle-read.service';
import {
  ProviderRecentExitsQueryService,
  type ProviderRecentExitProjection,
} from './provider-recent-exits-query.service';

describe('ProviderRecentExitsQueryService', () => {
  const asOf = new Date('2026-10-11T12:00:00Z');
  const projection: ProviderRecentExitProjection = {
    id: 'application-1',
    listingId: 'listing-1',
    status: ApplicationStatus.REJECTED,
    publicReason: ApplicationRejectionReason.NOT_SELECTED,
    activeAt: new Date(asOf.getTime() - 100_000),
    exitedAt: new Date(asOf.getTime() - 60_000),
  };
  const application = {
    id: projection.id,
    status: projection.status,
    publicReason: projection.publicReason,
    createdAt: projection.activeAt,
    listing: {
      status: ListingStatus.PUBLISHED,
      minimumHouseholdNetIncome: null,
      schufaRequired: false,
      incomeProofRequired: false,
      suitableForPeopleCount: null,
      petsPolicy: null,
      smokingPolicy: null,
    },
    applicant: {
      name: 'Known applicant',
      profile: {
        peopleCount: 1,
        introduction: 'Hello',
        householdNetIncome: 3000,
        adultsCount: 1,
        childrenCount: 0,
        schufaAvailable: true,
        incomeProofAvailable: true,
        hasPets: false,
        isSmoker: false,
      },
    },
    listingEvents: [{ occurredAt: projection.exitedAt }],
  };
  const query =
    jest.fn<
      (
        ...args: unknown[]
      ) => Promise<(ProviderRecentExitProjection & { totalCount: bigint })[]>
    >();
  const findMany =
    jest.fn<(...args: unknown[]) => Promise<(typeof application)[]>>();
  const evaluate = jest.fn<EligibilityService['evaluateCriteria']>();
  let service: ProviderRecentExitsQueryService;
  let lifecycle: ApplicationLifecycleReadService;
  let tx: PrismaService;

  beforeEach(async () => {
    query.mockReset();
    findMany.mockReset();
    evaluate.mockReset();
    evaluate.mockReturnValue(new EligibilityResponseDto(true, [], [], asOf));
    const module = await Test.createTestingModule({
      providers: [
        ProviderRecentExitsQueryService,
        ApplicationLifecycleReadService,
        ApplicationAdmissionService,
        {
          provide: EligibilityService,
          useValue: { evaluateCriteria: evaluate },
        },
        {
          provide: PrismaService,
          useValue: { $queryRaw: query, application: { findMany } },
        },
      ],
    }).compile();
    service = module.get(ProviderRecentExitsQueryService);
    lifecycle = module.get(ApplicationLifecycleReadService);
    tx = module.get(PrismaService);
  });

  it('retains full qualifying counts when only a bounded page is projected', async () => {
    query.mockResolvedValue([{ ...projection, totalCount: 8n }]);
    const result = await service.select(tx, 'provider-1', [
      'listing-1',
      'listing-2',
    ]);
    expect(result.get('listing-1')).toEqual({
      items: [projection],
      totalCount: 8,
    });
    expect(result.get('listing-2')).toEqual({ items: [], totalCount: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not query or hydrate identities for empty input', async () => {
    expect(await service.select(tx, 'provider-1', [])).toEqual(new Map());
    expect(await service.cards(tx, 'provider-1', [], asOf)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('batches hydration, preserves projection order and exposes only preview profile fields', async () => {
    findMany.mockResolvedValue([application]);
    const result = await service.cards(tx, 'provider-1', [projection], asOf);
    expect(result[0]).toMatchObject({
      ...projection,
      canRestore: true,
      applicant: {
        name: 'Known applicant',
        profile: { peopleCount: 1, introduction: 'Hello' },
      },
    });
    expect(result[0].applicant.profile).toEqual({
      peopleCount: 1,
      introduction: 'Hello',
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [projection.id] },
          listing: { providerId: 'provider-1' },
        },
      }),
    );
  });

  it.each([-1, 0, 1])(
    'shares the exact 60-second restoration boundary at offset %s',
    (offset) => {
      const now = new Date(projection.exitedAt.getTime() + 60_000 + offset);
      expect(
        lifecycle.restoreAllowed(
          application,
          projection.exitedAt,
          false,
          true,
          now,
        ),
      ).toBe(offset >= 0);
    },
  );

  it('never grants restoration for withdrawal, system rejection, newer attempts or current ineligibility', () => {
    expect(
      lifecycle.restoreAllowed(
        { ...application, status: ApplicationStatus.WITHDRAWN },
        projection.exitedAt,
        false,
        true,
        asOf,
      ),
    ).toBe(false);
    expect(
      lifecycle.restoreAllowed(
        {
          ...application,
          publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        },
        projection.exitedAt,
        false,
        true,
        asOf,
      ),
    ).toBe(false);
    expect(
      lifecycle.restoreAllowed(
        application,
        projection.exitedAt,
        true,
        true,
        asOf,
      ),
    ).toBe(false);
    expect(
      lifecycle.restoreAllowed(
        application,
        projection.exitedAt,
        false,
        false,
        asOf,
      ),
    ).toBe(false);
    expect(
      lifecycle.restoreAllowed(
        { ...application, listing: { status: ListingStatus.PAUSED } },
        projection.exitedAt,
        false,
        true,
        asOf,
      ),
    ).toBe(false);
  });
});
