import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import { OwnerReassignment } from './owner-reassignment';
import { AgentTransferRequests } from './agent-transfer-requests';
import {
  ListingAssignmentDto,
  ListingTransferRequestDto,
} from './dto/assignment-input.dto';

@Controller('provider')
@UseGuards(AuthenticatedGuard)
export class ListingAssignmentsController {
  constructor(
    private readonly owners: OwnerReassignment,
    private readonly transfers: AgentTransferRequests,
  ) {}

  @Patch('listings/:id/responsibility')
  reassign(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Body() input: ListingAssignmentDto,
  ) {
    const actor = providerActorFromRequest(req);
    return this.owners.run(actor.authority, {
      ...input,
      listingId,
      workspaceId: actor.workspaceId,
    });
  }

  @Post('listings/:id/transfer-requests')
  request(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Body() input: ListingTransferRequestDto,
  ) {
    const actor = providerActorFromRequest(req);
    return this.transfers.request(actor, {
      ...input,
      listingId,
      workspaceId: actor.workspaceId,
      expiresAt: new Date(input.expiresAt),
    });
  }

  @Post('listing-transfer-requests/:id/approve')
  approve(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'APPROVED',
    );
  }

  @Post('listing-transfer-requests/:id/reject')
  reject(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'REJECTED',
    );
  }

  @Post('listing-transfer-requests/:id/cancel')
  cancel(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'CANCELLED',
    );
  }
}
