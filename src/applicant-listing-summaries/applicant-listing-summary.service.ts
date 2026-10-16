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
import { ApplicantListingAttentionEnricher } from '../application-attention/applicant-listing-attention.enricher';
import type { ApplicantListingAttentionDto } from '../application-attention/dto/attention-response.dto';
import { ApplicationAdmissionResponseDto } from '../applications/dto/application-admission-response.dto';
import type { ApplicationAdmission } from '../applications/application-admission.service';

export type BuildApplicantListingSummariesOptions = {
  readonly isSavedByListingId: ReadonlySet<string>;
  readonly applicantProfile?: ApplicantProfile | null;
};

function isActiveApplicant(user: SafeUser | null): user is SafeUser {
  return user?.role === Role.APPLICANT && user.status === UserStatus.ACTIVE;
}

@Injectable()
export class ApplicantListingSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationsService: ApplicationsService,
    private readonly eligibilityService: EligibilityService,
    private readonly listingAttention: ApplicantListingAttentionEnricher,
  ) {}

  applicationAttentionFor(
    applicantUser: SafeUser | null,
    blockingByListingId: ReadonlyMap<string, BlockingApplicationState>,
  ): Promise<ReadonlyMap<string, ApplicantListingAttentionDto>> {
    if (!isActiveApplicant(applicantUser) || blockingByListingId.size === 0) {
      return Promise.resolve(new Map());
    }
    return this.listingAttention.forApplications(
      applicantUser.id,
      blockingByListingId,
    );
  }

  async buildSummaries(
    applicantUser: SafeUser | null,
    listings: readonly ApplicantListingSummaryBuildSource[],
    options: BuildApplicantListingSummariesOptions,
  ): Promise<ApplicantListingSummaryDto[]> {
    if (listings.length === 0) {
      return [];
    }

    const evaluationTimestamp = new Date();

    const isApplicant = isActiveApplicant(applicantUser);

    let profile: ApplicantProfile | null = null;
    let blockingApplicationsByListingId: ReadonlyMap<
      string,
      BlockingApplicationState
    > = new Map();
    let admissions: ReadonlyMap<string, ApplicationAdmission> = new Map();

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
      admissions = await this.applicationsService.findAdmissionForListings(
        applicantUser.id,
        listings.map((listing) => ({
          id: listing.id,
          eligible: this.eligibilityService.evaluateCriteria(listing, profile)
            .canApply,
        })),
        evaluationTimestamp,
      );
    }

    const attentionByListingId = await this.applicationAttentionFor(
      applicantUser,
      blockingApplicationsByListingId,
    );

    return listings.map((listing) =>
      this.buildSummary(
        listing,
        applicantUser,
        profile,
        blockingApplicationsByListingId,
        evaluationTimestamp,
        options.isSavedByListingId.has(listing.id),
        new ApplicationAdmissionResponseDto(admissions.get(listing.id)),
        attentionByListingId.get(listing.id) ?? null,
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
    admission: ApplicationAdmissionResponseDto,
    applicationAttention: ApplicantListingAttentionDto | null,
  ): ApplicantListingSummaryDto {
    const isApplicant = isActiveApplicant(applicantUser);

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
      admission,
      applicationAttention,
    );
  }
}
