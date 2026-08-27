import { describe, expect, it } from '@jest/globals';

import { ApplicationStatus } from '../../generated/prisma/enums';
import {
  ProviderActiveApplicationResponseDto,
  type ProviderActiveApplicationRecord,
} from './provider-active-application-response.dto';

const APPLICATION_ID = '00000000-0000-4000-8000-000000000010';
const LISTING_ID = '00000000-0000-4000-8000-000000000011';

function makeRecord(
  overrides: Partial<ProviderActiveApplicationRecord> = {},
): ProviderActiveApplicationRecord {
  return {
    id: APPLICATION_ID,
    listingId: LISTING_ID,
    status: ApplicationStatus.ACTIVE,
    applicant: {
      name: 'Anna Applicant',
      profile: {
        peopleCount: 3,
      },
    },
    warnings: [],
    ...overrides,
  };
}

describe('ProviderActiveApplicationResponseDto', () => {
  it('maps only the minimal provider application summary', () => {
    const dto = new ProviderActiveApplicationResponseDto(makeRecord());

    expect(dto).toEqual({
      id: APPLICATION_ID,
      listingId: LISTING_ID,
      status: ApplicationStatus.ACTIVE,
      applicant: {
        name: 'Anna Applicant',
        peopleCount: 3,
        warnings: [],
      },
    });
    expect(dto).not.toHaveProperty('applicantId');
    expect(dto).not.toHaveProperty('queueOrder');
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto).not.toHaveProperty('updatedAt');
    expect(dto).not.toHaveProperty('rejectedAt');
    expect(dto).not.toHaveProperty('publicReason');
    expect(dto.applicant).not.toHaveProperty('id');
    expect(dto.applicant).not.toHaveProperty('email');
    expect(dto.applicant).not.toHaveProperty('passwordHash');
    expect(dto.applicant).not.toHaveProperty('householdNetIncome');
    expect(dto.applicant).not.toHaveProperty('incomeProofAvailable');
    expect(dto.applicant).not.toHaveProperty('schufaAvailable');
    expect(dto.applicant).not.toHaveProperty('adultsCount');
    expect(dto.applicant).not.toHaveProperty('childrenCount');
    expect(dto.applicant).not.toHaveProperty('hasPets');
    expect(dto.applicant).not.toHaveProperty('petsNote');
    expect(dto.applicant).not.toHaveProperty('smokingStatus');
    expect(dto.applicant).not.toHaveProperty('isSmoker');
  });

  it('returns warnings from the service record', () => {
    const dto = new ProviderActiveApplicationResponseDto(
      makeRecord({ warnings: ['pets_by_arrangement'] }),
    );

    expect(dto.applicant.warnings).toEqual(['pets_by_arrangement']);
  });

  it('returns null profile fields when the applicant has no profile', () => {
    const dto = new ProviderActiveApplicationResponseDto(
      makeRecord({
        applicant: {
          name: 'No Profile',
          profile: null,
        },
      }),
    );

    expect(dto.applicant).toEqual({
      name: 'No Profile',
      peopleCount: null,
      warnings: [],
    });
  });
});
