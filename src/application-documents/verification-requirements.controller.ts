import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import {
  OutstandingRequirementsQueryDto,
  ProviderRequirementsQueryDto,
} from './dto/verification-input.dto';
import { VerificationQueryService } from './verification-query.service';

@Controller('provider/applications/:applicationId/verification-requirements')
@UseGuards(AuthenticatedGuard)
export class ProviderVerificationRequirementsController {
  constructor(private readonly queries: VerificationQueryService) {}
  @Get()
  list(
    @Param() params: DocumentApplicationParamsDto,
    @Req() request: Request,
    @Query() query: ProviderRequirementsQueryDto,
  ) {
    return this.queries.requirements(
      params.applicationId,
      providerActorFromRequest(request),
      'provider',
      query,
    );
  }
}

@Controller('applicant/applications/:applicationId/verification-requirements')
@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
export class ApplicantVerificationRequirementsController {
  constructor(private readonly queries: VerificationQueryService) {}
  @Get()
  list(
    @Param() params: DocumentApplicationParamsDto,
    @Req() request: Request,
    @Query() query: OutstandingRequirementsQueryDto,
  ) {
    return this.queries.requirements(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      query,
    );
  }
}
