import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ApplicantProfile, Listing } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateProfile,
  hardProfileMatchWhere,
} from './profile-eligibility-evaluator';
import type {
  ApplicantEligibilityFacts,
  ListingEligibilityCriteria,
} from './profile-eligibility-evaluator';
export type {
  ApplicantEligibilityFacts,
  ListingEligibilityCriteria,
} from './profile-eligibility-evaluator';
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService) {}
  async check(listingId: string, applicantId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.status !== 'PUBLISHED')
      throw new UnprocessableEntityException(
        'This listing is not accepting applications',
      );
    const profile = await this.prisma.applicantProfile.findUnique({
      where: { applicantId },
    });
    return this.evaluate(listing, profile);
  }
  evaluate(listing: Listing, profile: ApplicantProfile | null) {
    return evaluateProfile(listing, profile);
  }
  evaluateCriteria(
    criteria: ListingEligibilityCriteria,
    profile: ApplicantEligibilityFacts | null,
  ) {
    return evaluateProfile(criteria, profile);
  }
  // Onboarding helper only; eligibility is always evaluated against a listing's enabled rules.
  isProfileComplete(profile: ApplicantProfile | null): boolean {
    return (
      !!profile &&
      [
        'householdNetIncome',
        'adultsCount',
        'childrenCount',
        'hasPets',
        'isSmoker',
      ].every(
        (field) =>
          profile[field as keyof ApplicantProfile] !== null &&
          profile[field as keyof ApplicantProfile] !== undefined,
      )
    );
  }
  buildHardMatchWhere(profile: ApplicantProfile | null) {
    return hardProfileMatchWhere(profile);
  }
}
