import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicantProfile, Application } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import type { EligibilityWarning } from '../eligibility/dto/eligibility-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_APPLICATIONS_LIMIT } from './application-lifecycle.constants';
import { BLOCKING_APPLICATION_STATUSES } from './blocking-application-statuses';
import type { BlockingApplicationState } from './applicant-listing-application-state';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';
import type { ProviderActiveApplicationRecord } from './dto/provider-active-application-response.dto';
import type { ProviderExitedApplicationRecord } from './dto/provider-exited-application-response.dto';

const EXITED_APPLICATIONS_LIMIT = 5;

function computeProviderActiveApplicantWarnings(
  profile: Pick<ApplicantProfile, 'hasPets' | 'isSmoker'> | null,
  listing: {
    petsPolicy: PetsPolicy | null;
    smokingPolicy: SmokingPolicy | null;
  },
): EligibilityWarning[] {
  const warnings: EligibilityWarning[] = [];

  if (profile === null) {
    return warnings;
  }

  if (
    profile.hasPets === true &&
    listing.petsPolicy === PetsPolicy.BY_ARRANGEMENT
  ) {
    warnings.push('pets_by_arrangement');
  }

  if (
    profile.isSmoker === true &&
    listing.smokingPolicy === SmokingPolicy.BY_ARRANGEMENT
  ) {
    warnings.push('smoking_by_arrangement');
  }

  return warnings;
}

@Injectable()
export class ApplicationProcessQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllByApplicantWithListing(
    applicantId: string,
  ): Promise<ApplicantApplicationRecord[]> {
    return this.prisma.application.findMany({
      where: { applicantId },
      orderBy: { createdAt: 'desc' },
      include: {
        listing: {
          select: {
            id: true,
            title: true,
            city: true,
            coldRent: true,
            images: {
              select: { secureUrl: true, isCover: true, position: true },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });
  }

  async findBlockingApplicationsForListings(
    applicantId: string,
    listingIds: readonly string[],
  ): Promise<ReadonlyMap<string, BlockingApplicationState>> {
    if (listingIds.length === 0) {
      return new Map();
    }

    const applications = await this.prisma.application.findMany({
      where: {
        applicantId,
        listingId: { in: [...listingIds] },
        status: { in: [...BLOCKING_APPLICATION_STATUSES] },
      },
      select: { listingId: true, status: true, publicReason: true },
      orderBy: { createdAt: 'desc' },
    });
    const applicationsByListingId = new Map<string, BlockingApplicationState>();

    for (const application of applications) {
      if (applicationsByListingId.has(application.listingId)) {
        continue;
      }

      applicationsByListingId.set(application.listingId, {
        status: application.status,
        publicReason: application.publicReason,
      });
    }

    return applicationsByListingId;
  }

  async findBlockingApplicationForListing(
    applicantId: string,
    listingId: string,
  ): Promise<BlockingApplicationState | undefined> {
    const applicationsByListingId =
      await this.findBlockingApplicationsForListings(applicantId, [listingId]);
    return applicationsByListingId.get(listingId);
  }

  async findAllByProvider(providerId: string): Promise<Application[]> {
    return this.prisma.application.findMany({
      where: {
        listing: { providerId },
        status: { not: ApplicationStatus.WAITING },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByListing(
    listingId: string,
    providerId: string,
  ): Promise<Application[]> {
    await this.assertOwnedListing(listingId, providerId);

    return this.prisma.application.findMany({
      where: {
        listingId,
        listing: { providerId },
        status: { not: ApplicationStatus.WAITING },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findWaitingCountByListing(
    listingId: string,
    providerId: string,
  ): Promise<number> {
    await this.assertOwnedListing(listingId, providerId);

    return this.prisma.application.count({
      where: { listingId, status: ApplicationStatus.WAITING },
    });
  }

  async findActiveByListing(
    listingId: string,
    providerId: string,
  ): Promise<ProviderActiveApplicationRecord[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true, petsPolicy: true, smokingPolicy: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const applications = await this.prisma.application.findMany({
      where: {
        listingId,
        status: ApplicationStatus.ACTIVE,
      },
      orderBy: [{ activeAt: 'asc' }, { id: 'asc' }],
      take: ACTIVE_APPLICATIONS_LIMIT,
      select: {
        id: true,
        listingId: true,
        status: true,
        activeAt: true,
        applicant: {
          select: {
            name: true,
            profile: {
              select: {
                peopleCount: true,
                introduction: true,
                hasPets: true,
                isSmoker: true,
              },
            },
          },
        },
      },
    });

    return applications.map((application) => ({
      id: application.id,
      listingId: application.listingId,
      status: application.status,
      activeAt: application.activeAt,
      applicant: {
        name: application.applicant.name,
        profile: application.applicant.profile
          ? {
              peopleCount: application.applicant.profile.peopleCount,
              introduction: application.applicant.profile.introduction,
            }
          : null,
      },
      warnings: computeProviderActiveApplicantWarnings(
        application.applicant.profile,
        listing,
      ),
    }));
  }

  async findExitedByListing(
    listingId: string,
    providerId: string,
  ): Promise<{ items: ProviderExitedApplicationRecord[]; totalCount: number }> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    type ExitedApplicationRow = {
      id: string;
      listingId: string;
      status: string;
      publicReason: string | null;
      activeAt: Date;
      rejectedAt: Date | null;
      withdrawnAt: Date | null;
      applicantName: string;
      peopleCount: number | null;
      introduction: string | null;
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.$queryRaw<ExitedApplicationRow[]>`
        SELECT
          a.id,
          a.listing_id AS "listingId",
          a.status,
          a.public_reason AS "publicReason",
          a.active_at AS "activeAt",
          a.rejected_at AS "rejectedAt",
          a.withdrawn_at AS "withdrawnAt",
          u.name AS "applicantName",
          ap.people_count AS "peopleCount",
          ap.introduction AS "introduction"
        FROM "applications" AS a
        JOIN "users" AS u ON u.id = a.applicant_id
        LEFT JOIN "applicant_profiles" AS ap ON ap.applicant_id = a.applicant_id
        WHERE a.listing_id = ${listingId}::uuid
          AND a.active_at IS NOT NULL
          AND a.status IN ('withdrawn', 'rejected')
        ORDER BY COALESCE(a.rejected_at, a.withdrawn_at) DESC NULLS LAST, a.id DESC
        LIMIT ${EXITED_APPLICATIONS_LIMIT}
      `,
      this.prisma.application.count({
        where: {
          listingId,
          activeAt: { not: null },
          status: {
            in: [ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED],
          },
        },
      }),
    ]);

    const mapStatus = (value: string): ApplicationStatus => {
      switch (value) {
        case 'withdrawn':
          return ApplicationStatus.WITHDRAWN;
        case 'rejected':
          return ApplicationStatus.REJECTED;
        default:
          throw new Error(`Unexpected exited application status: ${value}`);
      }
    };

    const mapReason = (
      value: string | null,
    ): ApplicationRejectionReason | null => {
      if (value === null) {
        return null;
      }

      switch (value) {
        case 'not_selected':
          return ApplicationRejectionReason.NOT_SELECTED;
        case 'listing_rented':
          return ApplicationRejectionReason.LISTING_RENTED;
        case 'profile_no_longer_eligible':
          return ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE;
        default:
          throw new Error(
            `Unexpected exited application rejection reason: ${value}`,
          );
      }
    };

    const items = rows.map((row) => {
      const exitedAt = row.rejectedAt ?? row.withdrawnAt;

      if (!exitedAt) {
        throw new Error(
          `Exited application ${row.id} has neither rejectedAt nor withdrawnAt`,
        );
      }

      return {
        id: row.id,
        listingId: row.listingId,
        status: mapStatus(row.status),
        publicReason: mapReason(row.publicReason),
        activeAt: row.activeAt,
        exitedAt,
        applicant: {
          name: row.applicantName,
          profile:
            row.peopleCount === null && row.introduction === null
              ? null
              : {
                  peopleCount: row.peopleCount,
                  introduction: row.introduction,
                },
        },
      };
    });

    return { items, totalCount: Number(totalCount) };
  }

  private async assertOwnedListing(
    listingId: string,
    providerId: string,
  ): Promise<void> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
  }
}
