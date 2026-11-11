import { ConflictException, Injectable } from '@nestjs/common';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import { AssignmentParticipants } from './assignment-participants';
import { AssignmentRepository } from './persistence/assignment.repository';
import {
  assertAssignmentListing,
  assertAssignmentOwner,
} from './domain/assignment.policy';
import type { AssignmentCommand } from './domain/assignment.types';
import { captureAssignmentCommand } from './domain/assignment-command';

@Injectable()
export class OwnerReassignment {
  constructor(
    private readonly participants: AssignmentParticipants,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly assignments: AssignmentRepository,
  ) {}

  async run(authority: HumanAuthority, input: AssignmentCommand) {
    const command = captureAssignmentCommand(input);
    const requirement = {
      workspaceId: command.workspaceId,
      action: 'listing.assignment.reassign',
      resourceIds: [command.listingId],
      purpose: 'OPERATIONAL' as const,
      requiredRole: 'OWNER' as const,
    };
    const plan = await this.participants.discover(
      authority,
      requirement,
      command.listingId,
      command.targetMembershipId,
    );
    return this.writes.run(
      authority,
      requirement,
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: plan.ownershipRevision,
        membershipIds: plan.members.map((m) => m.id),
        userIds: plan.members.map((m) => m.userId),
      },
      async (context, tx) => {
        assertAssignmentOwner(context);
        const current = await tx.workspaceMembership.findMany({
          where: {
            workspaceId: command.workspaceId,
            id: { in: plan.members.map((m) => m.id) },
          },
          include: { user: { select: { status: true } } },
        });
        for (const bound of plan.members)
          if (
            !current.some((m) => m.id === bound.id && m.userId === bound.userId)
          )
            throw new ConflictException('Assignment participant changed');
        const target = current.find((m) => m.id === command.targetMembershipId);
        if (
          !target ||
          target.status !== 'ACTIVE' ||
          target.user.status !== 'ACTIVE'
        )
          throw new ConflictException('Assignment target is ineligible');
      },
      async (tx, context) => {
        const listing = await this.assignments.lockListing(
          tx,
          command.workspaceId,
          command.listingId,
        );
        assertAssignmentListing(
          context,
          listing,
          command.expectedListingRevision,
        );
        if (listing.responsible_membership_id !== plan.sourceId)
          throw new ConflictException('Responsibility changed');
        return this.assignments.assign(tx, listing, {
          targetMembershipId: command.targetMembershipId,
          reason: 'OWNER_REASSIGNMENT',
          initiator: context.membershipId,
          commandId: command.commandId,
          correlationId: command.correlationId,
        });
      },
    );
  }
}
