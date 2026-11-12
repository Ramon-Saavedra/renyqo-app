import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantListingAccess } from '../listings/applicant-listing-access';
import {
  evaluateProfile,
  PROFILE_EVALUATOR_VERSION,
} from './profile-eligibility-evaluator';

@Controller('applicant/applications')
@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
export class ApplicationEligibilityReadController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicantListingAccess,
  ) {}
  @Get(':id/profile-eligibility')
  async summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ) {
    const authority = sessionAuthorityFromRequest(request);
    return this.access.readApplication(
      authority,
      id,
      async () => {},
      async (tx) => {
        const app = await tx.application.findFirst({
          where: { id, applicantId: authority.userId },
          select: {
            id: true,
            listingId: true,
            applicant: { select: { profile: true } },
          },
        });
        if (!app) throw new NotFoundException('Application not found');
        const initial = await tx.applicationEligibilityAssessment.findFirst({
          where: { applicationId: id, trigger: 'APPLICATION_CREATED' },
        });
        const current = await tx.applicationEligibilityAssessment.findFirst({
          where: { applicationId: id },
          orderBy: { revision: 'desc' },
        });
        const criteria = await tx.listingCriteriaRevision.findFirst({
          where: { listingId: app.listingId },
          orderBy: { revision: 'desc' },
        });
        const project = (assessment: typeof current) =>
          assessment
            ? {
                status: 'RECORDED' as const,
                result: assessment.result,
                evaluatedAt: assessment.evaluatedAt,
                revision: assessment.revision,
              }
            : { status: 'UNKNOWN' as const };
        const evaluation = criteria
          ? evaluateProfile(criteria, app.applicant.profile)
          : null;
        const isCurrent =
          !!current &&
          current.criteriaRevisionId === criteria?.id &&
          current.evaluatorVersion === PROFILE_EVALUATOR_VERSION &&
          !!evaluation &&
          Object.entries(evaluation.facts).every(
            ([key, value]) => current[key as keyof typeof current] === value,
          );
        return {
          applicationId: id,
          initial: project(initial),
          current: project(current),
          currentMismatch: isCurrent ? current?.result === 'NO_MATCH' : null,
          currentAssessmentIsCurrent: isCurrent,
        };
      },
    );
  }
}
