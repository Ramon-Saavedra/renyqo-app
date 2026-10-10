import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventType,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  applicationProcessAllowsMutation,
  applicationCanWithdraw,
  providerCurationAllowed,
  type ApplicationProcessState,
} from './application-process.policy';
import type { AttentionAudience } from '../application-attention/application-pending-action';
import { ApplicationAdmissionService } from './application-admission.service';
import { ApplicationAdmissionResponseDto } from './dto/application-admission-response.dto';

@Injectable()
export class ApplicationLifecycleReadService {
  constructor(
    private readonly eligibility: EligibilityService,
    private readonly admissionService: ApplicationAdmissionService,
  ) {}

  async capabilities(
    tx: Prisma.TransactionClient,
    application: ApplicationProcessState & {
      id: string;
      applicantId: string;
      listingId: string;
      publicReason: ApplicationRejectionReason | null;
      createdAt: Date;
    },
    audience: AttentionAudience,
    asOf: Date,
  ) {
    const last =
      audience === 'provider'
        ? await tx.listingEvent.findFirst({
            where: {
              applicationId: application.id,
              type: {
                in: [
                  ListingEventType.REJECTED_BY_PROVIDER,
                  ListingEventType.RESTORED_BY_PROVIDER,
                ],
              },
            },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            select: { occurredAt: true },
          })
        : null;
    const curationAllowed = providerCurationAllowed(
      last?.occurredAt ?? null,
      asOf,
    );
    const provider = audience === 'provider';
    let canRestore = false;
    if (
      provider &&
      application.status === ApplicationStatus.REJECTED &&
      application.publicReason === ApplicationRejectionReason.NOT_SELECTED &&
      application.listing.status === ListingStatus.PUBLISHED &&
      curationAllowed &&
      !(await this.admissionService.hasNewerAttempt(tx, application))
    ) {
      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: application.listingId },
        select: {
          minimumHouseholdNetIncome: true,
          schufaRequired: true,
          incomeProofRequired: true,
          suitableForPeopleCount: true,
          petsPolicy: true,
          smokingPolicy: true,
        },
      });
      const profile = await tx.applicantProfile.findUnique({
        where: { applicantId: application.applicantId },
        select: {
          householdNetIncome: true,
          schufaAvailable: true,
          incomeProofAvailable: true,
          adultsCount: true,
          childrenCount: true,
          peopleCount: true,
          hasPets: true,
          isSmoker: true,
        },
      });
      canRestore = this.eligibility.evaluateCriteria(listing, profile).canApply;
    }
    let admission: ApplicationAdmissionResponseDto | undefined;
    if (!provider) {
      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: application.listingId },
        select: {
          status: true,
          minimumHouseholdNetIncome: true,
          schufaRequired: true,
          incomeProofRequired: true,
          suitableForPeopleCount: true,
          petsPolicy: true,
          smokingPolicy: true,
        },
      });
      const profile = await tx.applicantProfile.findUnique({
        where: { applicantId: application.applicantId },
        select: {
          householdNetIncome: true,
          schufaAvailable: true,
          incomeProofAvailable: true,
          adultsCount: true,
          childrenCount: true,
          peopleCount: true,
          hasPets: true,
          isSmoker: true,
        },
      });
      const histories = await this.admissionService.historyForListings(
        tx,
        application.applicantId,
        [application.listingId],
      );
      admission = new ApplicationAdmissionResponseDto(
        this.admissionService.evaluate(
          histories.get(application.listingId) ?? [],
          listing.status,
          this.eligibility.evaluateCriteria(listing, profile).canApply,
          asOf,
        ),
      );
    }
    return {
      canWithdraw: !provider && applicationCanWithdraw(application.status),
      canReject:
        provider &&
        application.status === ApplicationStatus.ACTIVE &&
        curationAllowed,
      canRestore,
      canSelectForRental:
        provider && applicationProcessAllowsMutation(application),
      ...(admission ? { admission } : {}),
    };
  }
}
