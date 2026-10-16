import { describe, expect, it } from '@jest/globals';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
} from '../generated/prisma/enums';
import { toApplicantListingApplicationStateFields } from './applicant-listing-application-state';

describe('toApplicantListingApplicationStateFields', () => {
  it('returns empty state when there is no blocking application', () => {
    expect(toApplicantListingApplicationStateFields(undefined)).toEqual({
      hasApplied: false,
      applicationStatus: null,
      publicReason: null,
    });
  });

  it.each([
    ApplicationStatus.ACTIVE,
    ApplicationStatus.WAITING,
    ApplicationStatus.ACCEPTED,
  ])('maps %s without publicReason', (status) => {
    expect(
      toApplicantListingApplicationStateFields({
        id: '00000000-0000-4000-8000-000000000010',
        status,
        publicReason: null,
      }),
    ).toEqual({
      hasApplied: true,
      applicationStatus: status,
      publicReason: null,
    });
  });

  it('maps REJECTED with authoritative publicReason', () => {
    expect(
      toApplicantListingApplicationStateFields({
        id: '00000000-0000-4000-8000-000000000010',
        status: ApplicationStatus.REJECTED,
        publicReason: ApplicationRejectionReason.NOT_SELECTED,
      }),
    ).toEqual({
      hasApplied: true,
      applicationStatus: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
    });
  });

  it('maps REJECTED with other rejection reasons', () => {
    expect(
      toApplicantListingApplicationStateFields({
        id: '00000000-0000-4000-8000-000000000010',
        status: ApplicationStatus.REJECTED,
        publicReason: ApplicationRejectionReason.LISTING_RENTED,
      }),
    ).toEqual({
      hasApplied: true,
      applicationStatus: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.LISTING_RENTED,
    });
  });
});
