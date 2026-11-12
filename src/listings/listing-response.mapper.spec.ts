import { describe, expect, it } from '@jest/globals';

import type { Listing } from '../generated/prisma/client';
import { ListingResponseMapper } from './listing-response.mapper';

const listing = {
  id: 'listing-id',
  workspaceId: '00000000-0000-4000-8000-000000000010',
  createdByMembershipId: '00000000-0000-4000-8000-000000000011',
  responsibleMembershipId: '00000000-0000-4000-8000-000000000011',
  revision: 1,
  assignmentSequence: 1,
  retiredAt: null,
  status: 'DRAFT',
  city: 'Berlin',
  zip: '10115',
  street: 'Hauptstrasse 1',
  district: 'Mitte',
  country: 'DE',
  showExactAddress: false,
  objectType: 'APARTMENT',
  livingArea: 50,
  rooms: 2,
  bedrooms: 1,
  coldRent: 1000,
  additionalCosts: 200,
  deposit: 2000,
  depositMonths: 2,
  availableFrom: new Date('2026-01-01'),
  title: 'Listing',
  shortDescription: 'Description',
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  displayOrder: 1,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  publishedAt: null,
  rentedAt: null,
} as unknown as Listing;

const image = {
  id: 'image-id',
  listingId: 'listing-id',
  publicId: 'private-id',
  secureUrl: 'https://example.com/image.jpg',
  position: 0,
  isCover: true,
  createdAt: new Date('2026-01-01'),
};

describe('ListingResponseMapper', () => {
  const mapper = new ListingResponseMapper();

  it('maps listing responses while hiding exact addresses by default', () => {
    const result = mapper.toListingResponse({ ...listing, images: [image] });

    expect(result.street).toBeNull();
    expect(result.images).toEqual([
      {
        id: 'image-id',
        secureUrl: 'https://example.com/image.jpg',
        position: 0,
        isCover: true,
      },
    ]);
  });

  it('serializes only declared provider fields, including when Prisma grows', () => {
    const result = mapper.toListingResponse({
      ...listing,
      internalSecret: 'private',
      _count: { applications: 1 },
    } as typeof listing);
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    for (const field of [
      'assignmentSequence',
      'retiredAt',
      'displayOrder',
      'internalSecret',
      '_count',
    ])
      expect(json).not.toHaveProperty(field);
    expect(json).toMatchObject({
      id: listing.id,
      workspaceId: listing.workspaceId,
      responsibleMembershipId: listing.responsibleMembershipId,
      revision: 1,
    });
  });

  it('preserves exact address exposure options', () => {
    expect(
      mapper.toListingResponse(
        { ...listing, images: [] },
        { exposeExactAddress: true },
      ).street,
    ).toBe('Hauptstrasse 1');

    expect(
      mapper.toListingResponse({
        ...listing,
        showExactAddress: true,
        images: [],
      }).street,
    ).toBe('Hauptstrasse 1');
  });

  it('maps provider overviews without exposing the Prisma count object', () => {
    const [result] = mapper.toProviderListingOverviewResponses([
      { ...listing, _count: { applications: 3 } },
    ]);

    expect(result.activeApplicationsCount).toBe(3);
    expect(result).not.toHaveProperty('_count');
    expect(
      mapper.toListingResponses([{ ...listing, images: [] }]),
    ).toHaveLength(1);
  });
});
