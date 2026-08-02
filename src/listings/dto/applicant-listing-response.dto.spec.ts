import { describe, expect, it } from '@jest/globals';
import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';
import { ApplicantListingDetailDto } from './applicant-listing-detail.dto';
import { ApplicantListingImageDto } from './applicant-listing-image.dto';
import { ApplicantListingSummaryDto } from './applicant-listing-summary.dto';
import { ApplicantListingsPageDto } from './applicant-listings-page.dto';

function serialized<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('ApplicantListingImageDto', () => {
  it('excludes publicId from the response', () => {
    const image = new ApplicantListingImageDto({
      secureUrl: 'https://example.com/img.jpg',
      position: 0,
      isCover: true,
    });

    const result = serialized(image);
    expect(result).not.toHaveProperty('publicId');
    expect(result.secureUrl).toBe('https://example.com/img.jpg');
    expect(result.position).toBe(0);
    expect(result.isCover).toBe(true);
  });
});

describe('ApplicantListingSummaryDto', () => {
  const baseListing = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Test Apartment',
    city: 'Berlin',
    zip: '10115',
    objectType: ObjectType.APARTMENT,
    livingArea: 62.5,
    rooms: 2,
    bedrooms: 1,
    coldRent: 1200,
    additionalCosts: 250,
    deposit: 2400,
    depositMonths: 2,
    availableFrom: new Date('2026-09-01'),
    shortDescription: 'Nice place',
    images: [
      {
        secureUrl: 'https://example.com/cover.jpg',
        position: 0,
        isCover: true,
      },
      {
        secureUrl: 'https://example.com/img2.jpg',
        position: 1,
        isCover: false,
      },
    ],
  };

  it('includes the cover image with only secureUrl', () => {
    const dto = new ApplicantListingSummaryDto(baseListing);
    const result = serialized(dto);

    expect(result.coverImage).toEqual({
      secureUrl: 'https://example.com/cover.jpg',
    });
  });

  it('returns null coverImage when there are no images', () => {
    const dto = new ApplicantListingSummaryDto({
      ...baseListing,
      images: [],
    });
    const result = serialized(dto);

    expect(result.coverImage).toBeNull();
  });

  it('finds cover image by isCover flag', () => {
    const dto = new ApplicantListingSummaryDto({
      ...baseListing,
      images: [
        {
          secureUrl: 'https://example.com/img1.jpg',
          position: 0,
          isCover: false,
        },
        {
          secureUrl: 'https://example.com/cover.jpg',
          position: 1,
          isCover: true,
        },
      ],
    });
    const result = serialized(dto);

    expect(result.coverImage).toEqual({
      secureUrl: 'https://example.com/cover.jpg',
    });
  });

  it('never exposes providerId', () => {
    const dto = new ApplicantListingSummaryDto(baseListing);
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId', () => {
    const dto = new ApplicantListingSummaryDto(baseListing);
    const result = serialized(dto);

    expect(result).not.toHaveProperty('publicId');
    expect(result.coverImage).not.toHaveProperty('publicId');
  });

  it('never exposes internal criteria fields', () => {
    const dto = new ApplicantListingSummaryDto(baseListing);
    const result = serialized(dto);

    expect(result).not.toHaveProperty('minimumHouseholdNetIncome');
    expect(result).not.toHaveProperty('schufaRequired');
    expect(result).not.toHaveProperty('incomeProofRequired');
    expect(result).not.toHaveProperty('suitableForPeopleCount');
    expect(result).not.toHaveProperty('petsPolicy');
    expect(result).not.toHaveProperty('smokingPolicy');
    expect(result).not.toHaveProperty('showExactAddress');
  });
});

describe('ApplicantListingDetailDto', () => {
  const baseDetail = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Test Apartment',
    city: 'Berlin',
    zip: '10115',
    street: 'Hauptstrasse 1',
    showExactAddress: true,
    objectType: ObjectType.APARTMENT,
    livingArea: 62.5,
    rooms: 2,
    bedrooms: 1,
    coldRent: 1200,
    additionalCosts: 250,
    deposit: 2400,
    depositMonths: 2,
    availableFrom: new Date('2026-09-01'),
    shortDescription: 'Nice place',
    minimumHouseholdNetIncome: 3000,
    schufaRequired: true,
    incomeProofRequired: false,
    suitableForPeopleCount: 2,
    petsPolicy: PetsPolicy.ALLOWED,
    smokingPolicy: SmokingPolicy.NON_SMOKERS_PREFERRED,
    publishedAt: new Date('2026-07-01'),
    images: [
      {
        secureUrl: 'https://example.com/cover.jpg',
        position: 0,
        isCover: true,
      },
    ],
  };

  it('exposes street when showExactAddress is true', () => {
    const dto = new ApplicantListingDetailDto(baseDetail);
    const result = serialized(dto);

    expect(result.street).toBe('Hauptstrasse 1');
  });

  it('hides street when showExactAddress is false', () => {
    const dto = new ApplicantListingDetailDto({
      ...baseDetail,
      showExactAddress: false,
      street: 'Hauptstrasse 1',
    });
    const result = serialized(dto);

    expect(result.street).toBeNull();
  });

  it('exposes public application requirements', () => {
    const dto = new ApplicantListingDetailDto(baseDetail);
    const result = serialized(dto);
    const requirements = result.requirements as Record<string, unknown>;

    expect(requirements.minimumHouseholdNetIncome).toBe(3000);
    expect(requirements.schufaRequired).toBe(true);
    expect(requirements.incomeProofRequired).toBe(false);
    expect(requirements.suitableForPeopleCount).toBe(2);
    expect(requirements.petsPolicy).toBe('ALLOWED');
    expect(requirements.smokingPolicy).toBe('NON_SMOKERS_PREFERRED');
  });

  it('never exposes showExactAddress flag', () => {
    const dto = new ApplicantListingDetailDto(baseDetail);
    const result = serialized(dto);

    expect(result).not.toHaveProperty('showExactAddress');
  });

  it('never exposes providerId', () => {
    const dto = new ApplicantListingDetailDto(baseDetail);
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId in images', () => {
    const dto = new ApplicantListingDetailDto(baseDetail);
    const result = serialized(dto);
    const images = result.images as Record<string, unknown>[];

    expect(images[0]).not.toHaveProperty('publicId');
    expect(images[0].secureUrl).toBe('https://example.com/cover.jpg');
  });
});

describe('ApplicantListingsPageDto', () => {
  it('wraps items with nextCursor null when there are no more pages', () => {
    const page = new ApplicantListingsPageDto([], null);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('wraps items with a nextCursor', () => {
    const summary = new ApplicantListingSummaryDto({
      id: '00000000-0000-4000-8000-000000000001',
      title: null,
      city: null,
      zip: null,
      objectType: null,
      livingArea: null,
      rooms: null,
      bedrooms: null,
      coldRent: null,
      additionalCosts: null,
      deposit: null,
      depositMonths: 2,
      availableFrom: null,
      shortDescription: null,
      images: [],
    });
    const page = new ApplicantListingsPageDto([summary], 'cursor-value');

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-value');
  });
});
