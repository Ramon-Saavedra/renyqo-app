import { Injectable } from '@nestjs/common';

import type { ApplicantProfile } from '../generated/prisma/client';
import { Role, UserStatus } from '../generated/prisma/enums';
import { ApplicationsService } from '../applications/applications.service';
import { toApplicantListingApplicationStateFields } from '../applications/applicant-listing-application-state';
import type { BlockingApplicationState } from '../applications/applicant-listing-application-state';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicantListingSummaryDto } from '../listings/dto/applicant-listing-summary.dto';
import type { ApplicantListingSummaryBuildSource } from './applicant-listing-summary-listing.select';
import { ProfileMatch } from '../listings/dto/applicant-listing-profile-match.enum';
import type { SafeUser } from '../users/types/safe-user.type';

export type BuildApplicantListingSummariesOptions = {
  readonly isSavedByListingId: ReadonlySet<string>;
  readonly applicantProfile?: ApplicantProfile | null;
};

@Injectable()
export class ApplicantListingSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationsService: ApplicationsService,
    private readonly eligibilityService: EligibilityService,
  ) {}

  async buildSummaries(
    applicantUser: SafeUser | null,
    listings: readonly ApplicantListingSummaryBuildSource[],
    options: BuildApplicantListingSummariesOptions,
  ): Promise<ApplicantListingSummaryDto[]> {
    if (listings.length === 0) {
      return [];
    }

    const evaluationTimestamp = new Date();

    const isApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE;

    let profile: ApplicantProfile | null = null;
    let blockingApplicationsByListingId: ReadonlyMap<
      string,
      BlockingApplicationState
    > = new Map();

    if (isApplicant) {
      profile =
        options.applicantProfile !== undefined
          ? options.applicantProfile
          : await this.prisma.applicantProfile.findUnique({
              where: { applicantId: applicantUser.id },
            });

      blockingApplicationsByListingId =
        await this.applicationsService.findBlockingApplicationsForListings(
          applicantUser.id,
          listings.map((listing) => listing.id),
        );
    }

    return listings.map((listing) =>
      this.buildSummary(
        listing,
        applicantUser,
        profile,
        blockingApplicationsByListingId,
        evaluationTimestamp,
        options.isSavedByListingId.has(listing.id),
      ),
    );
  }

  private buildSummary(
    listing: ApplicantListingSummaryBuildSource,
    applicantUser: SafeUser | null,
    profile: ApplicantProfile | null,
    blockingApplicationsByListingId: ReadonlyMap<
      string,
      BlockingApplicationState
    >,
    evaluationTimestamp: Date,
    isSaved: boolean,
  ): ApplicantListingSummaryDto {
    const isApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE;

    let profileMatch = ProfileMatch.UNKNOWN;

    if (isApplicant) {
      if (!this.eligibilityService.isProfileComplete(profile)) {
        profileMatch = ProfileMatch.PROFILE_INCOMPLETE;
      } else {
        const result = this.eligibilityService.evaluateCriteria(
          listing,
          profile,
        );
        profileMatch = result.canApply
          ? ProfileMatch.MATCH
          : ProfileMatch.NO_MATCH;
      }
    }

    return new ApplicantListingSummaryDto(
      listing,
      profileMatch,
      evaluationTimestamp,
      toApplicantListingApplicationStateFields(
        blockingApplicationsByListingId.get(listing.id),
      ),
      isSaved,
    );
  }
}
