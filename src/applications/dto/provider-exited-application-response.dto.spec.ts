import { describe, expect, it } from '@jest/globals';

import { ApplicationStatus } from '../../generated/prisma/enums';
import { ApplicationRejectionReason } from '../../generated/prisma/enums';
import {
  ProviderExitedApplicationResponseDto,
  type ProviderExitedApplicationRecord,
} from './provider-exited-application-response.dto';

const makeExitedRecord = (
  overrides: Partial<ProviderExitedApplicationRecord> = {},
): ProviderExitedApplicationRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  listingId: '00000000-0000-4000-8000-000000000002',
  status: ApplicationStatus.WITHDRAWN,
  publicReason: null,
  rejectedAt: null,
  withdrawnAt: new Date('2024-06-15'),
  applicant: { name: 'Anna Applicant' },
  ...overrides,
});

describe('ProviderExitedApplicationResponseDto', () => {
  it('maps a WITHDRAWN application with exitedAt from withdrawnAt', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.WITHDRAWN,
      withdrawnAt: new Date('2024-06-15'),
      rejectedAt: null,
    });

    const dto = new ProviderExitedApplicationResponseDto(record);

    expect(dto.id).toBe(record.id);
    expect(dto.listingId).toBe(record.listingId);
    expect(dto.applicantName).toBe('Anna Applicant');
    expect(dto.status).toBe(ApplicationStatus.WITHDRAWN);
    expect(dto.publicReason).toBeNull();
    expect(dto.exitedAt).toEqual(new Date('2024-06-15'));
  });

  it('maps a REJECTED application with exitedAt from rejectedAt', () => {
    const record = makeExitedRecord({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      rejectedAt: new Date('2024-07-01'),
      withdrawnAt: null,
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
      rejectedAt: new Date('2024-08-01'),
      withdrawnAt: null,
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
      rejectedAt: new Date('2024-09-01'),
      withdrawnAt: null,
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
