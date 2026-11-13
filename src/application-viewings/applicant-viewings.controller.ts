import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';

import { ApplicationViewingService } from './application-viewing.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import {
  RequestViewingChangeDto,
  SubmitViewingInterestDto,
  ViewingActionDto,
  ViewingApplicationParamsDto,
  ViewingParamsDto,
  ViewingQueryDto,
} from './dto/viewing-input.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications/:applicationId/viewings')
export class ApplicantViewingsController {
  constructor(
    private readonly viewings: ApplicationViewingService,
    private readonly outcomes: ApplicationViewingOutcomeService,
    private readonly queries: ApplicationViewingQueryService,
  ) {}
  @Get() list(
    @Param() params: ViewingApplicationParamsDto,
    @Query() query: ViewingQueryDto,
    @Req() request: Request,
  ) {
    return this.queries.list(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      query,
    );
  }
  @Get(':viewingId') detail(
    @Param() params: ViewingParamsDto,
    @Req() request: Request,
  ) {
    return this.queries.detail(
      params.applicationId,
      params.viewingId,
      sessionAuthorityFromRequest(request),
      'applicant',
    );
  }
  @Patch(':viewingId/accept') accept(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @Req() request: Request,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      sessionAuthorityFromRequest(request),
      'accept',
    );
  }
  @Patch(':viewingId/decline') decline(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @Req() request: Request,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      sessionAuthorityFromRequest(request),
      'decline',
    );
  }
  @Patch(':viewingId/request-another-time') requestChange(
    @Param() params: ViewingParamsDto,
    @Body() dto: RequestViewingChangeDto,
    @Req() request: Request,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      sessionAuthorityFromRequest(request),
      'request-change',
      dto,
    );
  }
  @Patch(':viewingId/interest') interest(
    @Param() params: ViewingParamsDto,
    @Body() dto: SubmitViewingInterestDto,
    @Req() request: Request,
  ) {
    return this.outcomes.interest(
      params.applicationId,
      params.viewingId,
      sessionAuthorityFromRequest(request),
      dto.interest,
      dto.confirmWithdrawal,
    );
  }
}
