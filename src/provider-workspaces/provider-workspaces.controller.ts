import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { WorkspaceDiscovery } from './workspace-discovery';
import { CurrentWorkspaceQuery } from './projections/current-workspace.query';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';

@UseGuards(AuthenticatedGuard)
@Controller('provider/workspaces')
export class ProviderWorkspacesController {
  constructor(
    private readonly discovery: WorkspaceDiscovery,
    private readonly current: CurrentWorkspaceQuery,
  ) {}

  @Get('current')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie, x-workspace-id')
  selected(@Req() request: Request) {
    return this.current.run(providerActorFromRequest(request));
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  list(@Req() request: Request) {
    return this.discovery.list(sessionAuthorityFromRequest(request));
  }
}
