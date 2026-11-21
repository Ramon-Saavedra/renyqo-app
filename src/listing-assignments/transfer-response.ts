import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import type { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import type { AssignmentParticipants } from './assignment-participants';
import type { AssignmentRepository } from './persistence/assignment.repository';
import { TRANSFER_RESPONSE_OPERATIONS } from '../provider-authorization/operations/transfer-response-operation';
import {
  assertAssignmentListing,
  assertAssignmentOwner,
} from './domain/assignment.policy';
import { translateListingTransferFailure } from './domain/listing-transfer-conflict';
import { auditedWork } from '../audit/context/audited-work';
import { assignmentAudit, transferAudit } from './assignment-audit';

export async function respondToTransfer(
  deps: {
    prisma: PrismaService;
    resolver: WorkspaceMembershipResolver;
    participants: AssignmentParticipants;
    writes: ProtectedWorkspaceTransactions;
    assignments: AssignmentRepository;
  },
  actor: ProviderActor,
  requestId: string,
  response: 'APPROVED' | 'REJECTED' | 'CANCELLED',
) {
  const operation = TRANSFER_RESPONSE_OPERATIONS[response];
  const requirement = {
    workspaceId: actor.workspaceId,
    action: operation,
    providerOperation: operation,
    resourceIds: [requestId],
    purpose: 'OPERATIONAL' as const,
  };
  const preview = await deps.resolver.read(
    deps.prisma,
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
  const plan = await deps.participants.discover(
    actor.authority,
    { ...requirement, resourceIds: [preview.listingId] },
    preview.listingId,
    preview.targetMembershipId,
    [preview.sourceMembershipId],
  );
  return deps.writes
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
      async (tx, ctx) =>
        auditedWork(tx, async () => {
          const listing = await deps.assignments.lockListing(
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
            data: {
              status: response,
              decidedByMembershipId: ctx.membershipId,
            },
          });
          if (response === 'APPROVED')
            await deps.assignments.assign(tx, listing, {
              targetMembershipId: request.targetMembershipId,
              reason: 'APPROVED_TRANSFER',
              initiator: request.sourceMembershipId,
              approver: ctx.membershipId,
              requestId: request.id,
              commandId: request.commandId,
              correlationId: request.correlationId ?? undefined,
            });
          await transferAudit(tx, ctx, result);
          if (
            response === 'APPROVED' &&
            listing.responsible_membership_id !== request.targetMembershipId
          )
            await assignmentAudit(
              tx,
              ctx,
              request.commandId,
              request.correlationId ?? undefined,
            );
          return result;
        }),
    )
    .catch(translateListingTransferFailure);
}
