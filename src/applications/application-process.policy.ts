import { ApplicationStatus, ListingStatus } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';

export type ApplicationProcessState = {
  status: ApplicationStatus;
  listing: { status: ListingStatus };
};

export function applicationProcessAllowsMutation(
  application: ApplicationProcessState,
): boolean {
  return (
    application.status === ApplicationStatus.ACTIVE &&
    (application.listing.status === ListingStatus.PUBLISHED ||
      application.listing.status === ListingStatus.PAUSED)
  );
}

const providerHiddenStatuses: ApplicationStatus[] = [ApplicationStatus.WAITING];
const providerVisibleWithoutHistory: ApplicationStatus[] = [
  ApplicationStatus.ACTIVE,
];

export function providerApplicationIsVisible(application: {
  status: ApplicationStatus;
  activeAt: Date | null;
}): boolean {
  return (
    !providerHiddenStatuses.includes(application.status) &&
    (providerVisibleWithoutHistory.includes(application.status) ||
      application.activeAt !== null)
  );
}

export function providerApplicationVisibility(
  providerId: string,
): Prisma.ApplicationWhereInput {
  return {
    listing: { providerId },
    status: { notIn: providerHiddenStatuses },
    OR: [
      { status: { in: providerVisibleWithoutHistory } },
      { activeAt: { not: null } },
    ],
  };
}
