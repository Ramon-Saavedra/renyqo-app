import { describe, expect, it } from '@jest/globals';
import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';
import { ApplicantListingDetailDto } from './applicant-listing-detail.dto';
import { ProfileMatch } from './applicant-listing-profile-match.enum';
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
    district: 'Mitte',
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
    petsPolicy: null,
    publishedAt: new Date('2025-01-01'),
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
    const dto = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result.coverImage).toEqual({
      secureUrl: 'https://example.com/cover.jpg',
    });
  });

  it('returns null coverImage when there are no images', () => {
    const dto = new ApplicantListingSummaryDto(
      {
        ...baseListing,
        images: [],
      },
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result.coverImage).toBeNull();
  });

  it('finds cover image by isCover flag', () => {
    const dto = new ApplicantListingSummaryDto(
      {
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
      },
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result.coverImage).toEqual({
      secureUrl: 'https://example.com/cover.jpg',
    });
  });

  it('never exposes providerId', () => {
    const dto = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId', () => {
    const dto = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('publicId');
    expect(result.coverImage).not.toHaveProperty('publicId');
  });

  it('never exposes internal criteria fields', () => {
    const dto = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('minimumHouseholdNetIncome');
    expect(result).not.toHaveProperty('schufaRequired');
    expect(result).not.toHaveProperty('incomeProofRequired');
    expect(result).not.toHaveProperty('suitableForPeopleCount');
    expect(result).not.toHaveProperty('smokingPolicy');
    expect(result).not.toHaveProperty('showExactAddress');
  });

  describe('isNew', () => {
    it('returns true when publishedAt is 1 day ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const oneDayAgo = new Date('2025-06-09T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: oneDayAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(true);
    });

    it('returns false when publishedAt is exactly 7 days ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const sevenDaysAgo = new Date('2025-06-03T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: sevenDaysAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is 8 days ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const eightDaysAgo = new Date('2025-06-02T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: eightDaysAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is null', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: null },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is in the future', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const future = new Date('2025-06-12T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: future },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });
  });
});

describe('ApplicantListingDetailDto', () => {
  const baseDetail = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Test Apartment',
    city: 'Berlin',
    zip: '10115',
    district: 'Mitte',
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
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result.street).toBe('Hauptstrasse 1');
  });

  it('hides street when showExactAddress is false', () => {
    const dto = new ApplicantListingDetailDto(
      {
        ...baseDetail,
        showExactAddress: false,
        street: 'Hauptstrasse 1',
      },
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result.street).toBeNull();
  });

  it('exposes public application requirements', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
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
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('showExactAddress');
  });

  it('never exposes providerId', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId in images', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const result = serialized(dto);
    const images = result.images as Record<string, unknown>[];

    expect(images[0]).not.toHaveProperty('publicId');
    expect(images[0].secureUrl).toBe('https://example.com/cover.jpg');
  });

  describe('isNew', () => {
    it('returns true when publishedAt is 1 day ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const oneDayAgo = new Date('2025-06-09T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: oneDayAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(true);
    });

    it('returns false when publishedAt is exactly 7 days ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const sevenDaysAgo = new Date('2025-06-03T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: sevenDaysAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is 8 days ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const eightDaysAgo = new Date('2025-06-02T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: eightDaysAgo },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is null', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: null },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is in the future', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const future = new Date('2025-06-12T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: future },
        ProfileMatch.UNKNOWN,
        now,
      );
      expect(dto.isNew).toBe(false);
    });
  });
});

describe('ApplicantListingsPageDto', () => {
  it('wraps items with nextCursor null when there are no more pages', () => {
    const page = new ApplicantListingsPageDto([], null, 0);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('wraps items with a nextCursor', () => {
    const summary = new ApplicantListingSummaryDto(
      {
        id: '00000000-0000-4000-8000-000000000001',
        title: null,
        city: null,
        zip: null,
        district: null,
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
        petsPolicy: null,
        publishedAt: null,
        images: [],
      },
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
    );
    const page = new ApplicantListingsPageDto([summary], 'cursor-value', 0);

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-value');
  });
});
