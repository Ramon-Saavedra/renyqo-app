import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import {
  OutstandingRequirementsQueryDto,
  ProviderRequirementsQueryDto,
} from './dto/verification-input.dto';
import { VerificationQueryService } from './verification-query.service';

@Controller('provider/applications/:applicationId/verification-requirements')
@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
export class ProviderVerificationRequirementsController {
  constructor(private readonly queries: VerificationQueryService) {}
  @Get()
  list(
    @Param() params: DocumentApplicationParamsDto,
    @CurrentUser() user: SafeUser,
    @Query() query: ProviderRequirementsQueryDto,
  ) {
    return this.queries.requirements(
      params.applicationId,
      user.id,
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
    @CurrentUser() user: SafeUser,
    @Query() query: OutstandingRequirementsQueryDto,
  ) {
    return this.queries.requirements(
      params.applicationId,
      user.id,
      'applicant',
      query,
    );
  }
}
