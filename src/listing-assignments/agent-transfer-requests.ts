import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import { AssignmentParticipants } from './assignment-participants';
import { AssignmentRepository } from './persistence/assignment.repository';
import {
  assertAssignmentListing,
  assertAssignmentOwner,
} from './domain/assignment.policy';
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
      resourceIds: [command.listingId],
      purpose: 'OPERATIONAL' as const,
    };
    const plan = await this.participants.discover(
      actor.authority,
      requirement,
      command.listingId,
      command.targetMembershipId,
    );
    return this.writes.run(
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
      async (tx, ctx) => {
        const listing = await this.assignments.lockListing(
          tx,
          ctx.workspaceId,
          command.listingId,
        );
        assertAssignmentListing(ctx, listing, command.expectedListingRevision);
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
            prior.expectedListingRevision !== command.expectedListingRevision ||
            prior.expiresAt.getTime() !== command.expiresAt.getTime()
          )
            throw new ConflictException('Transfer command input differs');
          return prior;
        }
        await tx.$executeRaw`UPDATE listing_transfer_requests SET status='EXPIRED' WHERE workspace_id=${ctx.workspaceId}::uuid
        AND listing_id=${listing.id}::uuid AND status='REQUESTED' AND expires_at<=clock_timestamp()`;
        const source = await tx.workspaceMembership.findUniqueOrThrow({
          where: { id: ctx.membershipId, workspaceId: ctx.workspaceId },
        });
        const target = await tx.workspaceMembership.findUniqueOrThrow({
          where: {
            id: command.targetMembershipId,
            workspaceId: ctx.workspaceId,
          },
        });
        return tx.listingTransferRequest.create({
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
      },
    );
  }

  async respond(
    actor: ProviderActor,
    requestId: string,
    response: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  ) {
    const requirement = {
      workspaceId: actor.workspaceId,
      action: 'listing.transfer.respond',
      resourceIds: [requestId],
      purpose: 'OPERATIONAL' as const,
    };
    const preview = await this.resolver.read(
      this.prisma,
      actor.authority,
      requirement,
      async (ctx, tx) => {
        const row = await tx.listingTransferRequest.findUnique({
          where: { id: requestId, workspaceId: ctx.workspaceId },
        });
        if (
          !row ||
          (ctx.role !== 'OWNER' && row.sourceMembershipId !== ctx.membershipId)
        )
          throw new NotFoundException('Transfer request not found');
        return row;
      },
    );
    const plan = await this.participants.discover(
      actor.authority,
      { ...requirement, resourceIds: [preview.listingId] },
      preview.listingId,
      preview.targetMembershipId,
      [preview.sourceMembershipId],
    );
    return this.writes
      .run(
        actor.authority,
        requirement,
        {
          kind: 'STRUCTURAL',
          expectedOwnershipRevision: plan.ownershipRevision,
          membershipIds: [
            ...new Set([
              ...plan.members.map((m) => m.id),
              preview.sourceMembershipId,
            ]),
          ],
          userIds: plan.members.map((m) => m.userId),
        },
        (ctx) => {
          if (response === 'CANCELLED') {
            if (ctx.membershipId !== preview.sourceMembershipId)
              throw new ForbiddenException('Source AGENT required');
          } else assertAssignmentOwner(ctx);
          return Promise.resolve();
        },
        async (tx, ctx) => {
          const listing = await this.assignments.lockListing(
            tx,
            ctx.workspaceId,
            preview.listingId,
          );
          await tx.$queryRaw`SELECT id FROM listing_transfer_requests WHERE id=${requestId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR UPDATE`;
          const request = await tx.listingTransferRequest.findUniqueOrThrow({
            where: { id: requestId, workspaceId: ctx.workspaceId },
          });
          if (request.status !== 'REQUESTED')
            throw new ConflictException('Transfer request already decided');
          if (
            response === 'APPROVED' &&
            request.expiresAt.getTime() <= Date.now()
          )
            throw new ConflictException(
              'Transfer request is stale or ineligible',
            );
          if (response === 'APPROVED')
            assertAssignmentListing(
              ctx,
              listing,
              request.expectedListingRevision,
            );
          const result = await tx.listingTransferRequest.update({
            where: { id: requestId, workspaceId: ctx.workspaceId },
            data: { status: response, decidedByMembershipId: ctx.membershipId },
          });
          if (response === 'APPROVED')
            await this.assignments.assign(tx, listing, {
              targetMembershipId: request.targetMembershipId,
              reason: 'APPROVED_TRANSFER',
              initiator: request.sourceMembershipId,
              approver: ctx.membershipId,
              requestId: request.id,
              commandId: request.commandId,
              correlationId: request.correlationId ?? undefined,
            });
          return result;
        },
      )
      .catch(translateListingTransferFailure);
  }
}
