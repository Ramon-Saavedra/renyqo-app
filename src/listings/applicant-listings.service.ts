import { publicListingSource } from '../published-listings/public-listing-source';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { ApplicantListingAccess } from './applicant-listing-access';
import { Injectable, NotFoundException } from '@nestjs/common';

import type { ApplicantProfile } from '../generated/prisma/client';
import { Role, UserStatus } from '../generated/prisma/enums';
import { ApplicationsService } from '../applications/applications.service';
import {
  toApplicantListingApplicationStateFields,
  type BlockingApplicationState,
} from '../applications/applicant-listing-application-state';
import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { SavedListingsService } from '../saved-listings/saved-listings.service';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import type {
  ApplicantListingsQueryDto,
  DiscoverySort,
} from './dto/applicant-listings-query.dto';
import {
  ProfileMatch,
  toProfileMatch,
} from './dto/applicant-listing-profile-match.enum';
import { ApplicantListingDiscoveryQuery } from './applicant-listing-discovery-query';
import { ApplicationAdmissionResponseDto } from '../applications/dto/application-admission-response.dto';

@Injectable()
export class ApplicantListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    private readonly applicationsService: ApplicationsService,
    private readonly savedListingsService: SavedListingsService,
    private readonly applicantListingSummaryService: ApplicantListingSummaryService,
    private readonly discoveryQuery: ApplicantListingDiscoveryQuery,
    private readonly access: ApplicantListingAccess,
  ) {}

  async isProfileCompleteForUser(userId: string): Promise<boolean> {
    const profile = await this.prisma.applicantProfile.findUnique({
      where: { applicantId: userId },
    });

    return this.eligibilityService.isProfileComplete(profile);
  }

  async findPublishedForApplicant(
    query: ApplicantListingsQueryDto,
    applicantUser: SafeUser | null,
    res?: { setHeader(name: string, value: string): void },
    authority?: HumanAuthority,
  ): Promise<ApplicantListingsPageDto> {
    const sort: DiscoverySort = query.sort ?? 'newest';
    const take = this.discoveryQuery.getPageSize(query);
    const activeApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE
        ? applicantUser
        : null;

    let profile: ApplicantProfile | null = null;

    if (activeApplicant) {
      if (!authority || authority.userId !== activeApplicant.id)
        throw new NotFoundException('Applicant not found');
      await this.access.assertPrincipal(authority);
      profile = await this.prisma.applicantProfile.findUnique({
        where: { applicantId: activeApplicant.id },
      });
    }

    const baseWhere = this.discoveryQuery.buildWhere(query, sort, profile);
    const [total, listings] = await this.prisma.$transaction(
      async (tx) => {
        const count = await tx.publicListingProjection.count({
          where: baseWhere,
        });
        const results = await tx.publicListingProjection.findMany({
          where: baseWhere,
          orderBy: this.discoveryQuery.getSortOrder(sort),
          take: take + 1,
          select: this.discoveryQuery.getSelect(),
        });
        return [count, results.map(publicListingSource)] as const;
      },
      { isolationLevel: 'RepeatableRead' },
    );

    const hasMore = listings.length > take;
    const items = hasMore ? listings.slice(0, take) : listings;

    let isSavedByListingId: ReadonlySet<string> = new Set();
    if (activeApplicant && items.length > 0) {
      isSavedByListingId =
        await this.savedListingsService.findSavedListingIdsForListings(
          activeApplicant.id,
          items.map((listing) => listing.id),
        );
    }

    const summaries = await this.applicantListingSummaryService.buildSummaries(
      applicantUser,
      items,
      { isSavedByListingId, applicantProfile: profile, authority },
    );

    const nextCursor =
      hasMore && items.length > 0
        ? this.discoveryQuery.encodeCursor(sort, items[items.length - 1])
        : null;

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    if (activeApplicant && authority)
      await this.access.assertPrincipal(authority);
    return new ApplicantListingsPageDto(summaries, nextCursor, total);
  }

  async findPublishedDetailForApplicant(
    id: string,
    applicantUser: SafeUser | null,
    res?: { setHeader(name: string, value: string): void },
    authority?: HumanAuthority,
  ): Promise<ApplicantListingDetailDto> {
    const projection = await this.prisma.publicListingProjection.findUnique({
      where: { id },
    });
    const listing = projection ? publicListingSource(projection) : null;

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const evaluationTimestamp = new Date();
    const isApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE;
    let profileMatch = ProfileMatch.UNKNOWN;
    let applicationState = toApplicantListingApplicationStateFields(undefined);
    let blockingApplication: BlockingApplicationState | undefined;
    let isSaved = false;
    let admission = new ApplicationAdmissionResponseDto();

    if (isApplicant) {
      if (!authority || authority.userId !== applicantUser.id)
        throw new NotFoundException('Applicant not found');
      await this.access.assertPrincipal(authority);
      const profile = await this.prisma.applicantProfile.findUnique({
        where: { applicantId: applicantUser.id },
      });

      profileMatch = toProfileMatch(
        this.eligibilityService.evaluateCriteria(listing, profile).result,
      );

      blockingApplication =
        await this.applicationsService.findBlockingApplicationForListing(
          applicantUser.id,
          listing.id,
        );
      applicationState =
        toApplicantListingApplicationStateFields(blockingApplication);
      const admissions =
        await this.applicationsService.findAdmissionForListings(
          applicantUser.id,
          [
            {
              id: listing.id,
              eligible: this.eligibilityService.evaluateCriteria(
                listing,
                profile,
              ).canApply,
            },
          ],
          evaluationTimestamp,
        );
      admission = new ApplicationAdmissionResponseDto(
        admissions.get(listing.id),
      );
      isSaved = await this.savedListingsService.isListingSaved(
        applicantUser.id,
        listing.id,
      );
    }

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    const applicationAttention =
      (
        await this.applicantListingSummaryService.applicationAttentionFor(
          applicantUser,
          blockingApplication
            ? new Map([[listing.id, blockingApplication]])
            : new Map(),
          authority,
        )
      ).get(listing.id) ?? null;

    if (isApplicant && authority) await this.access.assertPrincipal(authority);
    return new ApplicantListingDetailDto(
      listing,
      profileMatch,
      evaluationTimestamp,
      applicationState,
      isSaved,
      admission,
      applicationAttention,
    );
  }
}
