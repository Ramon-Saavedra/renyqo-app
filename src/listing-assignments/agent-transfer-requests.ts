import { respondToTransfer } from './transfer-response';
import { auditedWork } from '../audit/context/audited-work';
import { transferAudit } from './assignment-audit';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import { AssignmentParticipants } from './assignment-participants';
import { AssignmentRepository } from './persistence/assignment.repository';
import { assertAssignmentListing } from './domain/assignment.policy';
import type { AssignmentCommand } from './domain/assignment.types';
import { captureAssignmentCommand } from './domain/assignment-command';
import { translateListingTransferFailure } from './domain/listing-transfer-conflict';

@Injectable()
export class AgentTransferRequests {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly participants: AssignmentParticipants,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly assignments: AssignmentRepository,
  ) {}

  async request(
    actor: ProviderActor,
    input: AssignmentCommand & { expiresAt: Date },
  ) {
    const command = Object.freeze({
      ...captureAssignmentCommand(input),
      expiresAt: new Date(input.expiresAt),
    });
    const id = randomUUID();
    const requirement = {
      workspaceId: command.workspaceId,
      action: 'listing.transfer.request',
      providerOperation: 'listing.transfer.request' as const,
      resourceIds: [command.listingId],
      purpose: 'OPERATIONAL' as const,
    };
    const plan = await this.participants.discover(
      actor.authority,
      requirement,
      command.listingId,
      command.targetMembershipId,
    );
    const result = this.writes.run(
      actor.authority,
      requirement,
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: plan.ownershipRevision,
        membershipIds: plan.members.map((m) => m.id),
        userIds: plan.members.map((m) => m.userId),
      },
      async (ctx, tx) => {
        if (ctx.role !== 'AGENT' || ctx.membershipId !== plan.sourceId)
          throw new ForbiddenException('Current responsible AGENT required');
        const target = await tx.workspaceMembership.findUnique({
          where: {
            id: command.targetMembershipId,
            workspaceId: ctx.workspaceId,
          },
          include: { user: { select: { status: true } } },
        });
        if (
          !target ||
          target.role !== 'AGENT' ||
          target.status !== 'ACTIVE' ||
          target.user.status !== 'ACTIVE'
        )
          throw new ConflictException('Transfer target is ineligible');
      },
      async (tx, ctx) =>
        auditedWork(tx, async () => {
          const listing = await this.assignments.lockListing(
            tx,
            ctx.workspaceId,
            command.listingId,
          );
          assertAssignmentListing(
            ctx,
            listing,
            command.expectedListingRevision,
          );
          if (listing.responsible_membership_id !== ctx.membershipId)
            throw new ConflictException('Responsibility changed');
          const prior = await tx.listingTransferRequest.findUnique({
            where: {
              workspaceId_commandId: {
                workspaceId: ctx.workspaceId,
                commandId: command.commandId,
              },
            },
          });
          if (prior) {
            if (
              prior.listingId !== listing.id ||
              prior.sourceMembershipId !== ctx.membershipId ||
              prior.targetMembershipId !== command.targetMembershipId ||
              prior.expectedListingRevision !==
                command.expectedListingRevision ||
              prior.expiresAt.getTime() !== command.expiresAt.getTime()
            )
              throw new ConflictException('Transfer command input differs');
            return prior;
          }
          const expired = await tx.$queryRaw<
            import('../generated/prisma/client').ListingTransferRequest[]
          >`UPDATE listing_transfer_requests SET status='EXPIRED' WHERE workspace_id=${ctx.workspaceId}::uuid
        AND listing_id=${listing.id}::uuid AND status='REQUESTED' AND expires_at<=clock_timestamp() RETURNING id`;
          for (const old of expired) {
            const row = await tx.listingTransferRequest.findUniqueOrThrow({
              where: { id: old.id },
            });
            await transferAudit(tx, ctx, row);
          }
          const source = await tx.workspaceMembership.findUniqueOrThrow({
            where: { id: ctx.membershipId, workspaceId: ctx.workspaceId },
          });
          const target = await tx.workspaceMembership.findUniqueOrThrow({
            where: {
              id: command.targetMembershipId,
              workspaceId: ctx.workspaceId,
            },
          });
          const created = await tx.listingTransferRequest.create({
            data: {
              id,
              workspaceId: ctx.workspaceId,
              listingId: listing.id,
              sourceMembershipId: source.id,
              targetMembershipId: target.id,
              expectedListingRevision: listing.revision,
              expectedSourceRevision: source.revision,
              expectedTargetRevision: target.revision,
              expectedOwnershipRevision: plan.ownershipRevision,
              commandId: command.commandId,
              correlationId: command.correlationId,
              expiresAt: command.expiresAt,
            },
          });
          await transferAudit(tx, ctx, created);
          return created;
        }),
    );
    return result.catch(translateListingTransferFailure);
  }

  respond(
    actor: ProviderActor,
    requestId: string,
    response: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  ) {
    return respondToTransfer(
      {
        prisma: this.prisma,
        resolver: this.resolver,
        participants: this.participants,
        writes: this.writes,
        assignments: this.assignments,
      },
      actor,
      requestId,
      response,
    );
  }
}
