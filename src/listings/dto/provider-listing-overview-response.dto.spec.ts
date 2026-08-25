import { describe, expect, it } from '@jest/globals';

import { ListingStatus, ObjectType } from '../../generated/prisma/enums';
import {
  ProviderListingOverviewResponseDto,
  type ListingWithActiveApplicationsCount,
} from './provider-listing-overview-response.dto';

const LISTING_ID = '00000000-0000-4000-8000-000000000010';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000011';

function makeListing(
  overrides: Partial<ListingWithActiveApplicationsCount> = {},
): ListingWithActiveApplicationsCount {
  return {
    id: LISTING_ID,
    providerId: PROVIDER_ID,
    status: ListingStatus.PUBLISHED,
    city: 'Berlin',
    zip: '10115',
    street: 'Secret Street 1',
    district: null,
    country: 'DE',
    showExactAddress: false,
    objectType: ObjectType.APARTMENT,
    livingArea: 55,
    rooms: 2,
    bedrooms: 1,
    coldRent: 900,
    additionalCosts: null,
    deposit: null,
    depositMonths: 2,
    availableFrom: new Date('2024-06-01'),
    title: 'Kreuzberg Flat',
    shortDescription: null,
    photos: [],
    minimumHouseholdNetIncome: null,
    schufaRequired: false,
    incomeProofRequired: false,
    suitableForPeopleCount: null,
    petsPolicy: null,
    smokingPolicy: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    publishedAt: new Date('2024-01-03'),
    rentedAt: null,
    _count: { applications: 3 },
    ...overrides,
  };
}

describe('ProviderListingOverviewResponseDto', () => {
  it('maps activeApplicationsCount and preserves listing fields without exposing _count', () => {
    const dto = new ProviderListingOverviewResponseDto(makeListing(), {
      exposeExactAddress: true,
    });

    expect(dto.activeApplicationsCount).toBe(3);
    expect(dto.id).toBe(LISTING_ID);
    expect(dto.title).toBe('Kreuzberg Flat');
    expect(dto.street).toBe('Secret Street 1');
    expect(dto).not.toHaveProperty('_count');
    expect(dto).not.toHaveProperty('applications');
    expect(dto).not.toHaveProperty('applicant');
  });

  it('maps zero ACTIVE applications', () => {
    const dto = new ProviderListingOverviewResponseDto(
      makeListing({ _count: { applications: 0 } }),
    );

    expect(dto.activeApplicationsCount).toBe(0);
  });
});
