import { Injectable } from '@nestjs/common';
import type {
  Listing,
  ApplicantProfile,
  Prisma,
  ListingCriteriaRevision,
} from '../generated/prisma/client';
import { EligibilityAssessmentTrigger } from '../generated/prisma/enums';
import { ListingCriteriaRevisionService } from './listing-criteria-revision.service';
import type { ListingEligibilityState } from './profile-eligibility-evaluator';
import {
  evaluateProfile,
  PROFILE_EVALUATOR_VERSION,
} from './profile-eligibility-evaluator';

@Injectable()
export class ApplicationEligibilityAssessmentService {
  constructor(private readonly revisions: ListingCriteriaRevisionService) {}
  async record(
    tx: Prisma.TransactionClient,
    applicationId: string,
    listing: ListingEligibilityState,
    profile: ApplicantProfile | null,
    trigger: EligibilityAssessmentTrigger,
    actorUserId?: string,
    criteria?: ListingCriteriaRevision,
  ) {
    const revision = criteria ?? (await this.revisions.current(tx, listing));
    if (revision.listingId !== listing.id)
      throw new Error('Assessment criteria listing mismatch');
    const evaluation = evaluateProfile(revision, profile);
    const last = await tx.applicationEligibilityAssessment.findFirst({
      where: { applicationId },
      orderBy: { revision: 'desc' },
    });
    if (
      trigger !== EligibilityAssessmentTrigger.APPLICATION_CREATED &&
      last &&
      last.criteriaRevisionId === revision.id &&
      last.evaluatorVersion === PROFILE_EVALUATOR_VERSION &&
      Object.entries(evaluation.facts).every(
        ([key, value]) => last[key as keyof typeof last] === value,
      )
    )
      return last;
    return tx.applicationEligibilityAssessment.create({
      data: {
        applicationId,
        listingId: listing.id,
        criteriaRevisionId: revision.id,
        revision: (last?.revision ?? 0) + 1,
        trigger,
        actorUserId,
        evaluatorVersion: PROFILE_EVALUATOR_VERSION,
        evaluatedAt: evaluation.evaluatedAt,
        result: evaluation.result,
        ...evaluation.facts,
        checks: { create: evaluation.checks.map((check) => ({ ...check })) },
      },
    });
  }
  async reassessListing(
    tx: Prisma.TransactionClient,
    listing: Listing,
    criteria: ListingCriteriaRevision,
    actorUserId: string,
  ) {
    const applications = await tx.application.findMany({
      where: { listingId: listing.id, status: { in: ['ACTIVE', 'WAITING'] } },
      select: { id: true, applicant: { select: { profile: true } } },
      orderBy: { id: 'asc' },
    });
    for (const application of applications)
      await this.record(
        tx,
        application.id,
        listing,
        application.applicant.profile,
        EligibilityAssessmentTrigger.CRITERIA_CHANGED,
        actorUserId,
        criteria,
      );
  }
}
