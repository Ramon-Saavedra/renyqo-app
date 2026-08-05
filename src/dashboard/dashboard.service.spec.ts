import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Listing } from '../generated/prisma/client';
import { ListingStatus, ObjectType } from '../generated/prisma/enums';
import { ListingsService } from '../listings/listings.service';
import { DashboardService } from './dashboard.service';
import type { RecentListingSummary } from './types/dashboard-summary.type';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';

const makeRawListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: '00000000-0000-4000-8000-000000000002',
  providerId: PROVIDER_ID,
  status: ListingStatus.DRAFT,
  city: 'Berlin',
  zip: '10115',
  street: null,
  district: null,
  country: 'DE',
  showExactAddress: false,
  objectType: ObjectType.APARTMENT,
  livingArea: null,
  rooms: null,
  bedrooms: null,
  coldRent: null,
  additionalCosts: null,
  deposit: null,
  depositMonths: 2,
  availableFrom: null,
  title: null,
  shortDescription: null,
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: null,
  rentedAt: null,
  ...overrides,
});

const toSummary = (listing: Listing): RecentListingSummary => ({
  id: listing.id,
  title: listing.title,
  status: listing.status,
  city: listing.city,
  objectType: listing.objectType,
  coldRent: listing.coldRent,
  createdAt: listing.createdAt,
});

describe('DashboardService', () => {
  let service: DashboardService;
  let listingsService: jest.Mocked<ListingsService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: ListingsService,
          useValue: {
            countByProvider: jest.fn(),
            countDraftsByProvider: jest.fn(),
            findRecentByProvider: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(DashboardService);
    listingsService = module.get<jest.Mocked<ListingsService>>(ListingsService);
  });

  describe('getSummary', () => {
    it('returns aggregated dashboard summary with only summary fields in recentListings', async () => {
      const raw = [makeRawListing()];
      listingsService.countByProvider.mockResolvedValue(5);
      listingsService.countDraftsByProvider.mockResolvedValue(2);
      listingsService.findRecentByProvider.mockResolvedValue(raw);

      const result = await service.getSummary(PROVIDER_ID);

      expect(result).toEqual({
        objectsCount: 5,
        draftsCount: 2,
        newApplicationsCount: 0,
        recentListings: raw.map(toSummary),
      });
      expect(result.recentListings[0]).not.toHaveProperty('providerId');
      expect(result.recentListings[0]).not.toHaveProperty('street');
      expect(result.recentListings[0]).not.toHaveProperty('schufaRequired');
    });

    it('always returns newApplicationsCount as 0', async () => {
      listingsService.countByProvider.mockResolvedValue(10);
      listingsService.countDraftsByProvider.mockResolvedValue(3);
      listingsService.findRecentByProvider.mockResolvedValue([]);

      const result = await service.getSummary(PROVIDER_ID);

      expect(result.newApplicationsCount).toBe(0);
    });
  });
});
