import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../../auth/guards/authenticated.guard';
import { providerActorFromRequest } from '../../provider-authorization/provider-listing-access';
import { SecurityLinkTrafficGuard } from '../../security/security-link-traffic.guard';
import { OwnerInvitations } from '../commands/owner-invitations';
import { TeamQuery } from '../projections/team.query';
import { MemberPaletteQuery } from '../projections/member-palette.query';
import {
  CreateInvitationDto,
  InvitationMutationDto,
  TeamPageDto,
} from './invitation.dto';
@UseGuards(AuthenticatedGuard, SecurityLinkTrafficGuard)
@Controller('provider')
export class OwnerInvitationsController {
  constructor(
    private readonly commands: OwnerInvitations,
    private readonly team: TeamQuery,
    private readonly palette: MemberPaletteQuery,
  ) {}
  @Get('team/member-colors')
  @Header('Cache-Control', 'private, no-store')
  colors(@Req() req: Request) {
    return this.palette.run(providerActorFromRequest(req));
  }
  @Get('team')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie, x-workspace-id')
  list(@Req() req: Request, @Query() query: TeamPageDto) {
    return this.team.run(
      providerActorFromRequest(req),
      query.page,
      query.limit,
    );
  }
  @Post('workspace-invitations')
  create(@Req() req: Request, @Body() dto: CreateInvitationDto) {
    return this.commands.run(providerActorFromRequest(req), {
      kind: 'CREATE',
      ...dto,
    });
  }
  @Post('workspace-invitations/:id/resend')
  resend(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: InvitationMutationDto,
  ) {
    return this.commands.run(providerActorFromRequest(req), {
      kind: 'RESEND',
      id,
      ...dto,
    });
  }
  @Post('workspace-invitations/:id/revoke')
  revoke(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: InvitationMutationDto,
  ) {
    return this.commands.run(providerActorFromRequest(req), {
      kind: 'REVOKE',
      id,
      ...dto,
    });
  }
}
