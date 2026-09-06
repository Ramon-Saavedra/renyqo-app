import { describe, expect, it } from '@jest/globals';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';
import {
  toApplicantListingApplicationStateFields,
  type BlockingApplicationState,
} from '../../applications/applicant-listing-application-state';
import { ApplicantListingDetailDto } from './applicant-listing-detail.dto';
import { ProfileMatch } from './applicant-listing-profile-match.enum';
import { ApplicantListingImageDto } from './applicant-listing-image.dto';
import { ApplicantListingSummaryDto } from './applicant-listing-summary.dto';
import { ApplicantListingsPageDto } from './applicant-listings-page.dto';

function serialized<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function noApplicationState() {
  return toApplicantListingApplicationStateFields(undefined);
}

function applicationState(blocking: BlockingApplicationState) {
  return toApplicantListingApplicationStateFields(blocking);
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
    smokingPolicy: SmokingPolicy.NOT_ALLOWED,
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
      noApplicationState(),
      false,
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
      noApplicationState(),
      false,
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
      noApplicationState(),
      false,
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
      noApplicationState(),
      false,
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId', () => {
    const dto = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
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
      noApplicationState(),
      false,
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('minimumHouseholdNetIncome');
    expect(result).not.toHaveProperty('schufaRequired');
    expect(result).not.toHaveProperty('incomeProofRequired');
    expect(result).not.toHaveProperty('suitableForPeopleCount');
    expect(result).not.toHaveProperty('smokingPolicy');
    expect(result).not.toHaveProperty('showExactAddress');
  });

  it('exposes application state from the constructor argument', () => {
    const applied = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.MATCH,
      new Date('2025-01-01'),
      applicationState({
        status: ApplicationStatus.ACTIVE,
        publicReason: null,
      }),
      true,
    );
    const notApplied = new ApplicantListingSummaryDto(
      baseListing,
      ProfileMatch.MATCH,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );

    expect(applied.hasApplied).toBe(true);
    expect(applied.applicationStatus).toBe(ApplicationStatus.ACTIVE);
    expect(applied.publicReason).toBeNull();
    expect(notApplied.hasApplied).toBe(false);
    expect(notApplied.applicationStatus).toBeNull();
    expect(notApplied.publicReason).toBeNull();
  });

  describe('application state', () => {
    it.each([
      ApplicationStatus.ACTIVE,
      ApplicationStatus.WAITING,
      ApplicationStatus.ACCEPTED,
    ])('maps %s with null publicReason', (status) => {
      const dto = new ApplicantListingSummaryDto(
        baseListing,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({ status, publicReason: null }),
        false,
      );

      expect(dto.hasApplied).toBe(true);
      expect(dto.applicationStatus).toBe(status);
      expect(dto.publicReason).toBeNull();
    });

    it('maps REJECTED with NOT_SELECTED publicReason', () => {
      const dto = new ApplicantListingSummaryDto(
        baseListing,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
        }),
        false,
      );

      expect(dto.hasApplied).toBe(true);
      expect(dto.applicationStatus).toBe(ApplicationStatus.REJECTED);
      expect(dto.publicReason).toBe(ApplicationRejectionReason.NOT_SELECTED);
    });

    it('maps REJECTED with other publicReason values', () => {
      const dto = new ApplicantListingSummaryDto(
        baseListing,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.LISTING_RENTED,
        }),
        false,
      );

      expect(dto.publicReason).toBe(ApplicationRejectionReason.LISTING_RENTED);
    });
  });

  describe('isNew', () => {
    it('returns true when publishedAt is 1 day ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const oneDayAgo = new Date('2025-06-09T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: oneDayAgo },
        ProfileMatch.UNKNOWN,
        now,
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is null', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const dto = new ApplicantListingSummaryDto(
        { ...baseListing, publishedAt: null },
        ProfileMatch.UNKNOWN,
        now,
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
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
    smokingPolicy: SmokingPolicy.NOT_ALLOWED,
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
      noApplicationState(),
      false,
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
      noApplicationState(),
      false,
    );
    const result = serialized(dto);

    expect(result.street).toBeNull();
  });

  it('exposes public application requirements', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );
    const result = serialized(dto);
    const requirements = result.requirements as Record<string, unknown>;

    expect(requirements.minimumHouseholdNetIncome).toBe(3000);
    expect(requirements.schufaRequired).toBe(true);
    expect(requirements.incomeProofRequired).toBe(false);
    expect(requirements.suitableForPeopleCount).toBe(2);
    expect(requirements.petsPolicy).toBe('ALLOWED');
    expect(requirements.smokingPolicy).toBe('NOT_ALLOWED');
  });

  it('never exposes showExactAddress flag', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('showExactAddress');
  });

  it('never exposes providerId', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );
    const result = serialized(dto);

    expect(result).not.toHaveProperty('providerId');
  });

  it('never exposes Cloudinary publicId in images', () => {
    const dto = new ApplicantListingDetailDto(
      baseDetail,
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );
    const result = serialized(dto);
    const images = result.images as Record<string, unknown>[];

    expect(images[0]).not.toHaveProperty('publicId');
    expect(images[0].secureUrl).toBe('https://example.com/cover.jpg');
  });

  describe('application state', () => {
    it('defaults to no blocking application for anonymous callers', () => {
      const dto = new ApplicantListingDetailDto(
        baseDetail,
        ProfileMatch.UNKNOWN,
        new Date('2025-01-01'),
        noApplicationState(),
        false,
      );

      expect(dto.hasApplied).toBe(false);
      expect(dto.applicationStatus).toBeNull();
      expect(dto.publicReason).toBeNull();
    });

    it.each([
      ApplicationStatus.ACTIVE,
      ApplicationStatus.WAITING,
      ApplicationStatus.ACCEPTED,
    ])('maps %s with null publicReason', (status) => {
      const dto = new ApplicantListingDetailDto(
        baseDetail,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({ status, publicReason: null }),
        false,
      );

      expect(dto.hasApplied).toBe(true);
      expect(dto.applicationStatus).toBe(status);
      expect(dto.publicReason).toBeNull();
    });

    it('maps REJECTED with NOT_SELECTED publicReason', () => {
      const dto = new ApplicantListingDetailDto(
        baseDetail,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
        }),
        false,
      );

      expect(dto.hasApplied).toBe(true);
      expect(dto.applicationStatus).toBe(ApplicationStatus.REJECTED);
      expect(dto.publicReason).toBe(ApplicationRejectionReason.NOT_SELECTED);
    });

    it('maps REJECTED with other publicReason values', () => {
      const dto = new ApplicantListingDetailDto(
        baseDetail,
        ProfileMatch.MATCH,
        new Date('2025-01-01'),
        applicationState({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        }),
        false,
      );

      expect(dto.publicReason).toBe(
        ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
      );
    });
  });

  describe('isNew', () => {
    it('returns true when publishedAt is 1 day ago', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const oneDayAgo = new Date('2025-06-09T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: oneDayAgo },
        ProfileMatch.UNKNOWN,
        now,
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
      );
      expect(dto.isNew).toBe(false);
    });

    it('returns false when publishedAt is null', () => {
      const now = new Date('2025-06-10T12:00:00.000Z');
      const dto = new ApplicantListingDetailDto(
        { ...baseDetail, publishedAt: null },
        ProfileMatch.UNKNOWN,
        now,
        noApplicationState(),
        false,
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
        noApplicationState(),
        false,
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
        smokingPolicy: null,
        publishedAt: null,
        images: [],
      },
      ProfileMatch.UNKNOWN,
      new Date('2025-01-01'),
      noApplicationState(),
      false,
    );
    const page = new ApplicantListingsPageDto([summary], 'cursor-value', 0);

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-value');
  });
});
