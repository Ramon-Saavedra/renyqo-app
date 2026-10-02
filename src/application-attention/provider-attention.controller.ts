import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import {
  AttentionApplicationParamsDto,
  AttentionListingParamsDto,
  AttentionQueryDto,
} from './dto/attention-input.dto';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider')
export class ProviderAttentionController {
  constructor(private readonly queries: ApplicationAttentionQueryService) {}

  @Get('applications/:applicationId/attention')
  detail(
    @Param() params: AttentionApplicationParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.detail(user.id, 'provider', params.applicationId);
  }

  @Get('attention')
  aggregate(@Query() query: AttentionQueryDto, @CurrentUser() user: SafeUser) {
    return this.queries.aggregate(user.id, 'provider', query);
  }

  @Get('listings/:listingId/attention')
  listing(
    @Param() params: AttentionListingParamsDto,
    @Query() query: AttentionQueryDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.aggregate(user.id, 'provider', query, params.listingId);
  }
}
