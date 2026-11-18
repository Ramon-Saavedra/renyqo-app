import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../../auth/guards/authenticated.guard';
import { sessionAuthorityFromRequest } from '../../provider-authorization/domain/authority-reference';
import { SecurityLinkTrafficGuard } from '../../security/security-link-traffic.guard';
import { InviteeInvitations } from '../commands/invitee-invitations';
import { AcceptInvitationDto, InvitationTokenDto } from './invitation.dto';
@UseGuards(AuthenticatedGuard, SecurityLinkTrafficGuard)
@Controller('workspace-invitations')
export class InviteeInvitationsController {
  constructor(private readonly invitations: InviteeInvitations) {}
  @Post('inspect')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  inspect(@Req() req: Request, @Body() dto: InvitationTokenDto) {
    return this.invitations.inspect(
      sessionAuthorityFromRequest(req),
      dto.token,
    );
  }
  @Post('accept')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  accept(@Req() req: Request, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(
      sessionAuthorityFromRequest(req),
      dto.token,
      dto.commandId,
    );
  }
}
