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
  ListingResponsibilityResponseDto,
  ListingTransferRequestResponseDto,
} from './dto/assignment-response.dto';
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
  async reassign(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Body() input: ListingAssignmentDto,
  ) {
    const actor = providerActorFromRequest(req);
    const listing = await this.owners.run(actor.authority, {
      ...input,
      listingId,
      workspaceId: actor.workspaceId,
    });
    return new ListingResponsibilityResponseDto(listing);
  }

  @Post('listings/:id/transfer-requests')
  async request(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Body() input: ListingTransferRequestDto,
  ) {
    const actor = providerActorFromRequest(req);
    const transfer = await this.transfers.request(actor, {
      ...input,
      listingId,
      workspaceId: actor.workspaceId,
      expiresAt: new Date(input.expiresAt),
    });
    return new ListingTransferRequestResponseDto(transfer);
  }

  @Post('listing-transfer-requests/:id/approve')
  async approve(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const transfer = await this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'APPROVED',
    );
    return new ListingTransferRequestResponseDto(transfer);
  }

  @Post('listing-transfer-requests/:id/reject')
  async reject(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const transfer = await this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'REJECTED',
    );
    return new ListingTransferRequestResponseDto(transfer);
  }

  @Post('listing-transfer-requests/:id/cancel')
  async cancel(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const transfer = await this.transfers.respond(
      providerActorFromRequest(req),
      id,
      'CANCELLED',
    );
    return new ListingTransferRequestResponseDto(transfer);
  }
}
