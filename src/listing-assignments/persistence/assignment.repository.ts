import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  AssignmentListing,
  ListingAssignmentReason,
} from '../domain/assignment.types';
import { randomUUID } from 'node:crypto';

@Injectable()
export class AssignmentRepository {
  async lockListing(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    listingId: string,
  ) {
    const [row] = await tx.$queryRaw<AssignmentListing[]>`
      SELECT id,workspace_id,responsible_membership_id,revision,status::text FROM listings
      WHERE id=${listingId}::uuid AND workspace_id=${workspaceId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Listing not found');
    return row;
  }

  async assign(
    tx: Prisma.TransactionClient,
    listing: AssignmentListing,
    input: {
      targetMembershipId: string;
      reason: ListingAssignmentReason;
      initiator: string;
      approver?: string;
      requestId?: string;
      commandId: string;
      correlationId?: string;
    },
  ) {
    if (listing.responsible_membership_id === input.targetMembershipId)
      return listing;
    const [updated] = await tx.$queryRaw<
      (AssignmentListing & { assignment_sequence: number })[]
    >`
      UPDATE listings SET responsible_membership_id=${input.targetMembershipId}::uuid
      WHERE id=${listing.id}::uuid AND workspace_id=${listing.workspace_id}::uuid AND revision=${listing.revision}
      RETURNING id,workspace_id,responsible_membership_id,revision,status::text,assignment_sequence`;
    if (!updated) throw new ConflictException('Listing revision changed');
    await tx.$executeRaw`
      INSERT INTO listing_assignment_transitions(id,workspace_id,listing_id,sequence,previous_membership_id,new_membership_id,
        reason,initiated_by_membership_id,approved_by_membership_id,transfer_request_id,command_id,correlation_id)
      VALUES(${randomUUID()}::uuid,${listing.workspace_id}::uuid,${listing.id}::uuid,${updated.assignment_sequence},
        ${listing.responsible_membership_id}::uuid,${input.targetMembershipId}::uuid,${input.reason}::"ListingAssignmentReason",
        ${input.initiator}::uuid,${input.approver ?? null}::uuid,${input.requestId ?? null}::uuid,
        ${input.commandId}::uuid,${input.correlationId ?? null}::uuid)`;
    return updated;
  }
}
