import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type {
  ApplicantProfile,
  Listing,
  Prisma,
} from '../generated/prisma/client';
import {
  ListingStatus,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  type EligibilityReason,
  EligibilityResponseDto,
  type EligibilityWarning,
} from './dto/eligibility-response.dto';

export type ListingEligibilityCriteria = {
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean;
  incomeProofRequired: boolean;
  suitableForPeopleCount: number | null;
  petsPolicy: string | null;
  smokingPolicy: string | null;
};

const COMPLETE_PROFILE_FIELDS = [
  'householdNetIncome',
  'incomeProofAvailable',
  'schufaAvailable',
  'adultsCount',
  'childrenCount',
  'hasPets',
  'isSmoker',
] as const;

@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async check(
    listingId: string,
    applicantId: string,
  ): Promise<EligibilityResponseDto> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    if (listing.status !== ListingStatus.PUBLISHED) {
      throw new UnprocessableEntityException(
        'This listing is not accepting applications',
      );
    }

    const profile = await this.prisma.applicantProfile.findUnique({
      where: { applicantId },
    });
    return this.evaluate(listing, profile);
  }

  evaluate(
    listing: Listing,
    profile: ApplicantProfile | null,
  ): EligibilityResponseDto {
    const reasons = this.findReasons(listing, profile);
    const warnings = this.findWarnings(listing, profile);

    return new EligibilityResponseDto(
      reasons.length === 0,
      reasons,
      warnings,
      new Date(),
    );
  }

  evaluateCriteria(
    criteria: ListingEligibilityCriteria,
    profile: ApplicantProfile | null,
  ): EligibilityResponseDto {
    const reasons = this.findCriteriaReasons(criteria, profile);
    const warnings = this.findCriteriaWarnings(criteria, profile);

    return new EligibilityResponseDto(
      reasons.length === 0,
      reasons,
      warnings,
      new Date(),
    );
  }

  isProfileComplete(profile: ApplicantProfile | null): boolean {
    if (!profile) {
      return false;
    }

    return COMPLETE_PROFILE_FIELDS.every(
      (field) => profile[field] !== null && profile[field] !== undefined,
    );
  }

  buildHardMatchWhere(profile: ApplicantProfile): Prisma.ListingWhereInput {
    const incomeCondition: Prisma.ListingWhereInput =
      profile.householdNetIncome !== null &&
      profile.householdNetIncome !== undefined
        ? {
            OR: [
              { minimumHouseholdNetIncome: null },
              {
                minimumHouseholdNetIncome: {
                  lte: profile.householdNetIncome,
                },
              },
            ],
          }
        : { minimumHouseholdNetIncome: null };

    const schufaCondition: Prisma.ListingWhereInput =
      profile.schufaAvailable === true ? {} : { schufaRequired: false };

    const incomeProofCondition: Prisma.ListingWhereInput =
      profile.incomeProofAvailable === true
        ? {}
        : { incomeProofRequired: false };

    const householdSize =
      profile.adultsCount !== null &&
      profile.adultsCount !== undefined &&
      profile.childrenCount !== null &&
      profile.childrenCount !== undefined
        ? profile.adultsCount + profile.childrenCount
        : (profile.peopleCount ?? null);

    const householdCondition: Prisma.ListingWhereInput =
      householdSize !== null
        ? {
            OR: [
              { suitableForPeopleCount: null },
              { suitableForPeopleCount: { gte: householdSize } },
            ],
          }
        : { suitableForPeopleCount: null };

    const petsCondition: Prisma.ListingWhereInput =
      profile.hasPets === true
        ? {
            OR: [
              { petsPolicy: { not: PetsPolicy.NOT_ALLOWED } },
              { petsPolicy: null },
            ],
          }
        : {};
    const smokingCondition: Prisma.ListingWhereInput =
      profile.isSmoker === true
        ? {
            OR: [
              { smokingPolicy: { not: SmokingPolicy.NOT_ALLOWED } },
              { smokingPolicy: null },
            ],
          }
        : {};

    return {
      AND: [
        incomeCondition,
        schufaCondition,
        incomeProofCondition,
        householdCondition,
        petsCondition,
        smokingCondition,
      ],
    };
  }

  private findReasons(
    listing: Listing,
    profile: ApplicantProfile | null,
  ): EligibilityReason[] {
    const reasons: EligibilityReason[] = [];

    if (listing.minimumHouseholdNetIncome !== null) {
      const income = profile?.householdNetIncome;
      if (income === null || income === undefined) {
        reasons.push('household_income_not_available');
      } else if (income < listing.minimumHouseholdNetIncome) {
        reasons.push('household_income_below_requirement');
      }
    }

    if (listing.schufaRequired && profile?.schufaAvailable !== true) {
      reasons.push('schufa_required_but_not_available');
    }

    if (listing.incomeProofRequired && profile?.incomeProofAvailable !== true) {
      reasons.push('income_proof_required_but_not_available');
    }

    if (listing.suitableForPeopleCount !== null) {
      const householdSize = this.getHouseholdSize(profile);
      if (householdSize === null) {
        reasons.push('household_size_not_available');
      } else if (householdSize > listing.suitableForPeopleCount) {
        reasons.push('household_size_exceeds_requirement');
      }
    }

    if (
      listing.petsPolicy === PetsPolicy.NOT_ALLOWED &&
      profile?.hasPets === true
    ) {
      reasons.push('pets_not_allowed');
    }
    if (
      listing.smokingPolicy === SmokingPolicy.NOT_ALLOWED &&
      profile?.isSmoker === true
    ) {
      reasons.push('smoking_not_allowed');
    }

    return reasons;
  }

  private findCriteriaReasons(
    criteria: ListingEligibilityCriteria,
    profile: ApplicantProfile | null,
  ): EligibilityReason[] {
    const reasons: EligibilityReason[] = [];

    if (criteria.minimumHouseholdNetIncome !== null) {
      const income = profile?.householdNetIncome;
      if (income === null || income === undefined) {
        reasons.push('household_income_not_available');
      } else if (income < criteria.minimumHouseholdNetIncome) {
        reasons.push('household_income_below_requirement');
      }
    }

    if (criteria.schufaRequired && profile?.schufaAvailable !== true) {
      reasons.push('schufa_required_but_not_available');
    }

    if (
      criteria.incomeProofRequired &&
      profile?.incomeProofAvailable !== true
    ) {
      reasons.push('income_proof_required_but_not_available');
    }

    if (criteria.suitableForPeopleCount !== null) {
      const householdSize = this.getHouseholdSize(profile);
      if (householdSize === null) {
        reasons.push('household_size_not_available');
      } else if (householdSize > criteria.suitableForPeopleCount) {
        reasons.push('household_size_exceeds_requirement');
      }
    }

    if (
      criteria.petsPolicy === PetsPolicy.NOT_ALLOWED &&
      profile?.hasPets === true
    ) {
      reasons.push('pets_not_allowed');
    }
    if (
      criteria.smokingPolicy === SmokingPolicy.NOT_ALLOWED &&
      profile?.isSmoker === true
    ) {
      reasons.push('smoking_not_allowed');
    }

    return reasons;
  }

  private findWarnings(
    listing: Listing,
    profile: ApplicantProfile | null,
  ): EligibilityWarning[] {
    if (!profile) {
      return [];
    }

    const warnings: EligibilityWarning[] = [];
    const hasPets = profile.hasPets === true;
    const smokes = profile.isSmoker === true;

    if (hasPets && listing.petsPolicy === PetsPolicy.BY_ARRANGEMENT) {
      warnings.push('pets_by_arrangement');
    }

    if (smokes && listing.smokingPolicy === SmokingPolicy.BY_ARRANGEMENT) {
      warnings.push('smoking_by_arrangement');
    }

    return warnings;
  }

  private findCriteriaWarnings(
    criteria: ListingEligibilityCriteria,
    profile: ApplicantProfile | null,
  ): EligibilityWarning[] {
    if (!profile) {
      return [];
    }

    const warnings: EligibilityWarning[] = [];
    const hasPets = profile.hasPets === true;
    const smokes = profile.isSmoker === true;

    if (hasPets && criteria.petsPolicy === PetsPolicy.BY_ARRANGEMENT) {
      warnings.push('pets_by_arrangement');
    }

    if (smokes && criteria.smokingPolicy === SmokingPolicy.BY_ARRANGEMENT) {
      warnings.push('smoking_by_arrangement');
    }

    return warnings;
  }

  private getHouseholdSize(profile: ApplicantProfile | null): number | null {
    if (profile?.adultsCount !== null && profile?.adultsCount !== undefined) {
      if (
        profile.childrenCount !== null &&
        profile.childrenCount !== undefined
      ) {
        return profile.adultsCount + profile.childrenCount;
      }
    }

    return profile?.peopleCount ?? null;
  }
}
