import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';

import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';

import { ProviderApplicationOverviewQueryService } from './provider-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ApplicationHistoryQueryService } from './application-history-query.service';
import {
  ReadModelPageQueryDto,
  ReadModelApplicationParamsDto,
  ReadModelListingParamsDto,
  ReadModelRequestParamsDto,
} from './dto/read-model-input.dto';

@UseGuards(AuthenticatedGuard)
@Controller('provider')
export class ProviderReadModelsController {
  constructor(
    private readonly overviews: ProviderApplicationOverviewQueryService,
    private readonly workspaces: ApplicationWorkspaceQueryService,
    private readonly history: ApplicationHistoryQueryService,
  ) {}

  @Get('listings/overview')
  overview(@Req() request: Request, @Query() query: ReadModelPageQueryDto) {
    return this.overviews.overview(providerActorFromRequest(request), query);
  }

  @Get('listings/:listingId/application-overview')
  listing(@Req() request: Request, @Param() params: ReadModelListingParamsDto) {
    return this.overviews.listing(
      providerActorFromRequest(request),
      params.listingId,
    );
  }

  @Get('applications/:applicationId/workspace')
  workspace(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
  ) {
    return this.workspaces.workspace(
      params.applicationId,
      providerActorFromRequest(request),
      'provider',
    );
  }

  @Get('applications/:applicationId/activity')
  activity(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.activity(
      providerActorFromRequest(request),
      'provider',
      params.applicationId,
      query,
    );
  }

  @Get('applications/:applicationId/document-history')
  documents(
    @Req() request: Request,
    @Param() params: ReadModelApplicationParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.documents(
      providerActorFromRequest(request),
      'provider',
      params.applicationId,
      query,
    );
  }

  @Get('applications/:applicationId/document-requests/:requestId/files')
  files(
    @Req() request: Request,
    @Param() params: ReadModelRequestParamsDto,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.history.files(
      providerActorFromRequest(request),
      'provider',
      params.applicationId,
      params.requestId,
      query,
    );
  }
}
