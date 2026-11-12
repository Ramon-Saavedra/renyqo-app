import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';

import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';

import { ApplicationAttentionQueryService } from './application-attention-query.service';
import {
  AttentionApplicationParamsDto,
  AttentionListingParamsDto,
  AttentionQueryDto,
} from './dto/attention-input.dto';

@UseGuards(AuthenticatedGuard)
@Controller('provider')
export class ProviderAttentionController {
  constructor(private readonly queries: ApplicationAttentionQueryService) {}

  @Get('applications/:applicationId/attention')
  detail(
    @Param() params: AttentionApplicationParamsDto,
    @Req() request: Request,
  ) {
    return this.queries.detail(
      providerActorFromRequest(request),
      'provider',
      params.applicationId,
    );
  }

  @Get('attention')
  aggregate(@Query() query: AttentionQueryDto, @Req() request: Request) {
    return this.queries.aggregate(
      providerActorFromRequest(request),
      'provider',
      query,
    );
  }

  @Get('listings/:listingId/attention')
  listing(
    @Param() params: AttentionListingParamsDto,
    @Query() query: AttentionQueryDto,
    @Req() request: Request,
  ) {
    return this.queries.aggregate(
      providerActorFromRequest(request),
      'provider',
      query,
      params.listingId,
    );
  }
}
