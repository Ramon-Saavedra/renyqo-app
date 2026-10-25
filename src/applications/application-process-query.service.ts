import { Injectable, NotFoundException } from '@nestjs/common';
import {
  activeConsiderationOrder,
  considerationSummary,
  ApplicationConsiderationReadService,
} from './application-consideration-read';
import type { ApplicantProfile, Application } from '../generated/prisma/client';
import {
  ApplicationStatus,
  ListingStatus,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import type { EligibilityWarning } from '../eligibility/dto/eligibility-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRecentExitsQueryService } from './provider-recent-exits-query.service';
import { ACTIVE_APPLICATIONS_LIMIT } from './application-lifecycle.constants';
import { providerApplicationVisibility } from './application-process.policy';
import { BLOCKING_APPLICATION_STATUSES } from './blocking-application-statuses';
import type { BlockingApplicationState } from './applicant-listing-application-state';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';
import type { ProviderActiveApplicationRecord } from './dto/provider-active-application-response.dto';
import type { ProviderExitedApplicationRecord } from './dto/provider-exited-application-response.dto';
import {
  ApplicationAdmissionService,
  type ApplicationAdmission,
} from './application-admission.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly admissionService: ApplicationAdmissionService,
    private readonly recentExits: ProviderRecentExitsQueryService,
    private readonly consideration: ApplicationConsiderationReadService,
  ) {}

  async findAdmissionForListings(
    applicantId: string,
    listings: readonly { id: string; eligible: boolean }[],
    asOf: Date,
  ): Promise<ReadonlyMap<string, ApplicationAdmission>> {
    return this.prisma.$transaction(
      async (tx) => {
        const histories = await this.admissionService.historyForListings(
          tx,
          applicantId,
          listings.map((listing) => listing.id),
        );
        return new Map(
          listings.map((listing) => [
            listing.id,
            this.admissionService.evaluate(
              histories.get(listing.id) ?? [],
              ListingStatus.PUBLISHED,
              listing.eligible,
              asOf,
            ),
          ]),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

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
              orderBy: [
                { isCover: 'desc' },
                { position: 'asc' },
                { id: 'asc' },
              ],
              take: 1,
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
      select: { id: true, listingId: true, status: true, publicReason: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const applicationsByListingId = new Map<string, BlockingApplicationState>();

    for (const application of applications) {
      if (applicationsByListingId.has(application.listingId)) {
        continue;
      }

      applicationsByListingId.set(application.listingId, {
        id: application.id,
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
      where: providerApplicationVisibility(providerId),
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
        ...providerApplicationVisibility(providerId),
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
    return this.prisma.$transaction(
      async (tx) => {
        const listing = await tx.listing.findFirst({
          where: { id: listingId, providerId },
          select: { id: true, petsPolicy: true, smokingPolicy: true },
        });

        if (!listing) {
          throw new NotFoundException('Listing not found');
        }

        const applications = await tx.application.findMany({
          where: {
            listingId,
            status: ApplicationStatus.ACTIVE,
          },
          orderBy: activeConsiderationOrder,
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

        const considerations = await this.consideration.batch(
          tx,
          applications.map((row) => row.id),
        );
        return applications.map((application) => ({
          id: application.id,
          listingId: application.listingId,
          status: application.status,
          activeAt: application.activeAt,
          consideration:
            considerations.get(application.id) ?? considerationSummary(),
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
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async findExitedByListing(
    listingId: string,
    providerId: string,
  ): Promise<{ items: ProviderExitedApplicationRecord[]; totalCount: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = new Date();
        const listing = await tx.listing.findFirst({
          where: { id: listingId, providerId },
          select: { id: true },
        });
        if (!listing) throw new NotFoundException('Listing not found');
        const selections = await this.recentExits.select(tx, providerId, [
          listingId,
        ]);
        const selection = selections.get(listingId);
        if (!selection) throw new Error('Missing recent-exit selection');
        return {
          items: await this.recentExits.cards(
            tx,
            providerId,
            selection.items,
            asOf,
          ),
          totalCount: selection.totalCount,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
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
