import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';

import { ApplicantApplicationOverviewQueryService } from './applicant-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ApplicationHistoryQueryService } from './application-history-query.service';
import { ApplicantApplicationOverviewQueryDto } from './dto/applicant-application-overview-query.dto';
import {
  ReadModelPageQueryDto,
  ReadModelApplicationParamsDto,
  ReadModelRequestParamsDto,
} from './dto/read-model-input.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications')
export class ApplicantReadModelsController {
  constructor(
    private readonly overviews: ApplicantApplicationOverviewQueryService,
    private readonly workspaces: ApplicationWorkspaceQueryService,
    private readonly history: ApplicationHistoryQueryService,
  ) {}

  @Get('overview')
  overview(
    @Req() request: Request,
    @Query() query: ApplicantApplicationOverviewQueryDto,
  ) {
    return this.overviews.overview(sessionAuthorityFromRequest(request), query);
  }

  @Get(':applicationId/workspace')
  workspace(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
  ) {
    return this.workspaces.workspace(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
    );
  }

  @Get(':applicationId/activity')
  activity(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.activity(
      sessionAuthorityFromRequest(request),
      'applicant',
      params.applicationId,
      query,
    );
  }

  @Get(':applicationId/document-history')
  documents(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.documents(
      sessionAuthorityFromRequest(request),
      'applicant',
      params.applicationId,
      query,
    );
  }

  @Get(':applicationId/document-requests/:requestId/files')
  files(
    @Req() request: Request,
    @Param() params: ReadModelRequestParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.files(
      sessionAuthorityFromRequest(request),
      'applicant',
      params.applicationId,
      params.requestId,
      query,
    );
  }
}
