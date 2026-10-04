import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { ProviderApplicationOverviewQueryService } from './provider-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ApplicationHistoryQueryService } from './application-history-query.service';
import {
  ReadModelPageQueryDto,
  ReadModelApplicationParamsDto,
  ReadModelListingParamsDto,
  ReadModelRequestParamsDto,
} from './dto/read-model-input.dto';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider')
export class ProviderReadModelsController {
  constructor(
    private readonly overviews: ProviderApplicationOverviewQueryService,
    private readonly workspaces: ApplicationWorkspaceQueryService,
    private readonly history: ApplicationHistoryQueryService,
  ) {}

  @Get('listings/overview')
  overview(
    @CurrentUser() user: SafeUser,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.overviews.overview(user.id, query);
  }

  @Get('listings/:listingId/application-overview')
  listing(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelListingParamsDto,
  ) {
    return this.overviews.listing(user.id, params.listingId);
  }

  @Get('applications/:applicationId/workspace')
  workspace(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
  ) {
    return this.workspaces.workspace(params.applicationId, user.id, 'provider');
  }

  @Get('applications/:applicationId/activity')
  activity(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.activity(
      user.id,
      'provider',
      params.applicationId,
      query,
    );
  }

  @Get('applications/:applicationId/document-history')
  documents(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.documents(
      user.id,
      'provider',
      params.applicationId,
      query,
    );
  }

  @Get('applications/:applicationId/document-requests/:requestId/files')
  files(
    @CurrentUser() user: SafeUser,
    @Param() params: ReadModelRequestParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.files(
      user.id,
      'provider',
      params.applicationId,
      params.requestId,
      query,
    );
  }
}
