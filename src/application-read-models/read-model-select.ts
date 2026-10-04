import type { Prisma } from '../generated/prisma/client';

export const compactListingSelect = {
  id: true,
  title: true,
  city: true,
  coldRent: true,
  status: true,
} satisfies Prisma.ListingSelect;

export const readModelApplicationSelect = {
  id: true,
  applicantId: true,
  listingId: true,
  status: true,
  activeAt: true,
  createdAt: true,
  rejectedAt: true,
  withdrawnAt: true,
  publicReason: true,
  listing: { select: compactListingSelect },
} satisfies Prisma.ApplicationSelect;

export const providerApplicationSelect = {
  ...readModelApplicationSelect,
  applicant: {
    select: {
      name: true,
      profile: { select: { peopleCount: true, introduction: true } },
    },
  },
} satisfies Prisma.ApplicationSelect;

export type ReadModelApplication = Prisma.ApplicationGetPayload<{
  select: typeof readModelApplicationSelect;
}>;
export type ProviderReadModelApplication = Prisma.ApplicationGetPayload<{
  select: typeof providerApplicationSelect;
}>;
