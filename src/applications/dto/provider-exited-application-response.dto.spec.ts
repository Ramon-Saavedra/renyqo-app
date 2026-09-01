import { describe, expect, it } from '@jest/globals';

import { ApplicationStatus } from '../../generated/prisma/enums';
import { ApplicationRejectionReason } from '../../generated/prisma/enums';
import {
  ProviderExitedApplicationResponseDto,
  ProviderExitedApplicationsResponseDto,
  type ProviderExitedApplicationRecord,
} from './provider-exited-application-response.dto';

const makeExitedRecord = (
  overrides: Partial<ProviderExitedApplicationRecord> = {},
): ProviderExitedApplicationRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  listingId: '00000000-0000-4000-8000-000000000002',
  status: ApplicationStatus.WITHDRAWN,
  publicReason: null,
  exitedAt: new Date('2024-06-15'),
  applicant: { name: 'Anna Applicant' },
  ...overrides,
});

describe('ProviderExitedApplicationResponseDto', () => {
  it('maps a WITHDRAWN application', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.WITHDRAWN,
      exitedAt: new Date('2024-06-15'),
    });

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto.id).toBe(record.id);
    expect(dto.listingId).toBe(record.listingId);
    expect(dto.applicantName).toBe('Anna Applicant');
    expect(dto.status).toBe(ApplicationStatus.WITHDRAWN);
    expect(dto.publicReason).toBeNull();
    expect(dto.exitedAt).toEqual(new Date('2024-06-15'));
  });

  it('maps a REJECTED application', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      exitedAt: new Date('2024-07-01'),
    });

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto.status).toBe(ApplicationStatus.REJECTED);
    expect(dto.publicReason).toBe(ApplicationRejectionReason.NOT_SELECTED);
    expect(dto.exitedAt).toEqual(new Date('2024-07-01'));
  });

  it('preserves PROFILE_NO_LONGER_ELIGIBLE reason', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
      exitedAt: new Date('2024-08-01'),
    });

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto.publicReason).toBe(
      ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
    );
  });

  it('preserves LISTING_RENTED reason', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.LISTING_RENTED,
      exitedAt: new Date('2024-09-01'),
    });

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto.publicReason).toBe(ApplicationRejectionReason.LISTING_RENTED);
  });

  it('excludes sensitive fields from DTO output', () => {
    const record = makeExitedRecord();

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto).not.toHaveProperty('applicantId');
    expect(dto).not.toHaveProperty('queueOrder');
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto).not.toHaveProperty('updatedAt');
    expect(dto).not.toHaveProperty('activeAt');
  });
});

describe('ProviderExitedApplicationsResponseDto', () => {
  it('wraps items and totalCount', () => {
    const record = makeExitedRecord();

    const dto = new ProviderExitedApplicationsResponseDto({
      items: [record],
      totalCount: 7,
    });

    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]).toBeInstanceOf(ProviderExitedApplicationResponseDto);
    expect(dto.items[0].applicantName).toBe('Anna Applicant');
    expect(dto.totalCount).toBe(7);
  });

  it('handles empty items with zero totalCount', () => {
    const dto = new ProviderExitedApplicationsResponseDto({
      items: [],
      totalCount: 0,
    });

    expect(dto.items).toEqual([]);
    expect(dto.totalCount).toBe(0);
  });
});
