import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicantProfile } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicantListingAccess } from '../listings/applicant-listing-access';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicantListingAccess,
  ) {}
  async check(listingId: string, authority: HumanAuthority) {
    await this.access.assertPrincipal(authority);
    const applicantId = authority.userId;
    const listing = await this.prisma.publicListingProjection.findUnique({
      where: { id: listingId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    const profile = await this.prisma.applicantProfile.findUnique({
      where: { applicantId },
    });
    await this.access.assertPrincipal(authority);
    return this.evaluateCriteria(listing, profile);
  }
  evaluate(
    listing: ListingEligibilityCriteria,
    profile: ApplicantProfile | null,
  ) {
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
