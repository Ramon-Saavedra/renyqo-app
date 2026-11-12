import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { WorkspaceDiscovery } from './workspace-discovery';

@UseGuards(AuthenticatedGuard)
@Controller('provider/workspaces')
export class ProviderWorkspacesController {
  constructor(private readonly discovery: WorkspaceDiscovery) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  list(@Req() request: Request) {
    return this.discovery.list(sessionAuthorityFromRequest(request));
  }
}
