import {
  ApplicationStatus,
  type ApplicationRejectionReason,
} from '../generated/prisma/enums';

export type BlockingApplicationState = {
  readonly status: ApplicationStatus;
  readonly publicReason: ApplicationRejectionReason | null;
};

export type ApplicantListingApplicationStateFields = {
  readonly hasApplied: boolean;
  readonly applicationStatus: ApplicationStatus | null;
  readonly publicReason: ApplicationRejectionReason | null;
};

export function toApplicantListingApplicationStateFields(
  blocking: BlockingApplicationState | undefined,
): ApplicantListingApplicationStateFields {
  if (!blocking) {
    return {
      hasApplied: false,
      applicationStatus: null,
      publicReason: null,
    };
  }

  return {
    hasApplied: true,
    applicationStatus: blocking.status,
    publicReason:
      blocking.status === ApplicationStatus.REJECTED
        ? blocking.publicReason
        : null,
  };
}
