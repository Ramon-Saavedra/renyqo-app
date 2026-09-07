import type { Prisma } from '../generated/prisma/client';
import type { ListingEligibilityCriteria } from '../eligibility/eligibility.service';
import type { ApplicantListingSummarySource } from '../listings/dto/applicant-listing-summary.dto';

export const APPLICANT_LISTING_SUMMARY_LISTING_SELECT = {
  id: true,
  title: true,
  city: true,
  zip: true,
  district: true,
  objectType: true,
  livingArea: true,
  rooms: true,
  bedrooms: true,
  coldRent: true,
  additionalCosts: true,
  deposit: true,
  depositMonths: true,
  availableFrom: true,
  shortDescription: true,
  minimumHouseholdNetIncome: true,
  schufaRequired: true,
  incomeProofRequired: true,
  suitableForPeopleCount: true,
  petsPolicy: true,
  smokingPolicy: true,
  publishedAt: true,
  images: {
    select: { secureUrl: true, position: true, isCover: true },
    orderBy: { position: 'asc' as const },
  },
} satisfies Prisma.ListingSelect;

export type ApplicantListingSummaryBuildSource = ApplicantListingSummarySource &
  ListingEligibilityCriteria;
