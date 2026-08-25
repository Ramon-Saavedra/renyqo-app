import { describe, expect, it } from '@jest/globals';

import { ApplicationStatus, SmokingStatus } from '../../generated/prisma/enums';
import {
  ProviderActiveApplicationResponseDto,
  type ProviderActiveApplicationRecord,
} from './provider-active-application-response.dto';

const APPLICATION_ID = '00000000-0000-4000-8000-000000000010';
const LISTING_ID = '00000000-0000-4000-8000-000000000011';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000012';

function makeRecord(
  overrides: Partial<ProviderActiveApplicationRecord> = {},
): ProviderActiveApplicationRecord {
  return {
    id: APPLICATION_ID,
    listingId: LISTING_ID,
    applicantId: APPLICANT_ID,
    status: ApplicationStatus.ACTIVE,
    rejectedAt: null,
    publicReason: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    applicant: {
      name: 'Anna Applicant',
      email: 'anna@example.com',
      profile: {
        peopleCount: 3,
        adultsCount: 2,
        childrenCount: 1,
        householdNetIncome: 4200,
        incomeProofAvailable: true,
        schufaAvailable: true,
        hasPets: true,
        petsNote: 'One cat',
        smokingStatus: SmokingStatus.NON_SMOKER,
      },
    },
    ...overrides,
  };
}

describe('ProviderActiveApplicationResponseDto', () => {
  it('maps application fields and nested provider-safe applicant summary', () => {
    const dto = new ProviderActiveApplicationResponseDto(makeRecord());

    expect(dto).toEqual({
      id: APPLICATION_ID,
      listingId: LISTING_ID,
      applicantId: APPLICANT_ID,
      status: ApplicationStatus.ACTIVE,
      rejectedAt: null,
      publicReason: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-02T00:00:00.000Z'),
      applicant: {
        name: 'Anna Applicant',
        email: 'anna@example.com',
        peopleCount: 3,
        adultsCount: 2,
        childrenCount: 1,
        householdNetIncome: 4200,
        incomeProofAvailable: true,
        schufaAvailable: true,
        hasPets: true,
        petsNote: 'One cat',
        smokingStatus: SmokingStatus.NON_SMOKER,
      },
    });
    expect(dto).not.toHaveProperty('queueOrder');
    expect(dto.applicant).not.toHaveProperty('id');
    expect(dto.applicant).not.toHaveProperty('passwordHash');
  });

  it('returns null profile fields when the applicant has no profile', () => {
    const dto = new ProviderActiveApplicationResponseDto(
      makeRecord({
        applicant: {
          name: 'No Profile',
          email: 'noprofile@example.com',
          profile: null,
        },
      }),
    );

    expect(dto.applicant).toEqual({
      name: 'No Profile',
      email: 'noprofile@example.com',
      peopleCount: null,
      adultsCount: null,
      childrenCount: null,
      householdNetIncome: null,
      incomeProofAvailable: null,
      schufaAvailable: null,
      hasPets: null,
      petsNote: null,
      smokingStatus: null,
    });
  });
});
