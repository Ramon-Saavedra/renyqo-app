import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantApplicationOverviewQueryService } from './applicant-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ApplicationHistoryQueryService } from './application-history-query.service';
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
    @CurrentUser() user: SafeUser,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.overviews.overview(user.id, query);
  }

  @Get(':applicationId/workspace')
  workspace(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
  ) {
    return this.workspaces.workspace(
      params.applicationId,
      user.id,
      'applicant',
    );
  }

  @Get(':applicationId/activity')
  activity(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.activity(
      user.id,
      'applicant',
      params.applicationId,
      query,
    );
  }

  @Get(':applicationId/document-history')
  documents(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.documents(
      user.id,
      'applicant',
      params.applicationId,
      query,
    );
  }

  @Get(':applicationId/document-requests/:requestId/files')
  files(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelRequestParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.files(
      user.id,
      'applicant',
      params.applicationId,
      params.requestId,
      query,
    );
  }
}
