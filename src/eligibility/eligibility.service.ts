import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { ApplicantProfile, Listing } from '../generated/prisma/client';
import {
  ListingStatus,
  PetsPolicy,
  SmokingPolicy,
  SmokingStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  type EligibilityReason,
  EligibilityResponseDto,
  type EligibilityWarning,
} from './dto/eligibility-response.dto';

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

    return new EligibilityResponseDto(reasons.length === 0, reasons, warnings);
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
    const smokes =
      profile.smokingStatus === SmokingStatus.SMOKER ||
      profile.smokingStatus === SmokingStatus.OCCASIONALLY;

    if (hasPets && listing.petsPolicy === PetsPolicy.BY_ARRANGEMENT) {
      warnings.push('pets_by_arrangement');
    }

    if (hasPets && listing.petsPolicy === PetsPolicy.PREFER_NOT) {
      warnings.push('pets_not_preferred');
    }

    if (smokes && listing.smokingPolicy === SmokingPolicy.BY_ARRANGEMENT) {
      warnings.push('smoking_by_arrangement');
    }

    if (
      smokes &&
      listing.smokingPolicy === SmokingPolicy.NON_SMOKERS_PREFERRED
    ) {
      warnings.push('smoking_not_preferred');
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
