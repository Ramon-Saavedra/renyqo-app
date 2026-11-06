import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  OwnershipTransferOutcome,
  Prisma,
} from '../generated/prisma/client';
import { MembershipRepository } from './persistence/membership.repository';
import { OwnershipTransferIntentRepository } from './persistence/ownership-transfer-intent.repository';

export interface ConfirmTransfer {
  id: string;
  workspaceId: string;
  currentOwnerMembershipId: string;
  targetMembershipId: string;
  outcome: OwnershipTransferOutcome;
  expectedOwnershipRevision: number;
  expectedOwnerMembershipRevision: number;
  expectedTargetMembershipRevision: number;
  expiresAt: Date;
}

// Confirmation means confirmation of these immutable terms, including outcome.
// Actor authentication/reauthentication and audit are later dependencies: private
// persistence only, never a public command or an authority-granting operation.
@Injectable()
export class OwnershipTransferIntents {
  constructor(
    private readonly members: MembershipRepository,
    private readonly intents: OwnershipTransferIntentRepository,
  ) {}

  async confirmWithinTransaction(
    tx: Prisma.TransactionClient,
    input: ConfirmTransfer,
  ) {
    await this.members.lockWorkspace(
      tx,
      input.workspaceId,
      input.expectedOwnershipRevision,
    );
    await this.members.lockMembers(tx, input.workspaceId, [
      input.currentOwnerMembershipId,
      input.targetMembershipId,
    ]);
    // The existing workspace write serializes same-workspace creation retries;
    // global ID uniqueness rejects collisions with a different workspace.
    const existing = await tx.ownershipTransferIntent.findUnique({
      where: { id: input.id },
    });
    if (existing) {
      for (const key of [
        'workspaceId',
        'currentOwnerMembershipId',
        'targetMembershipId',
        'outcome',
        'expectedOwnershipRevision',
        'expectedOwnerMembershipRevision',
        'expectedTargetMembershipRevision',
      ] as const) {
        if (existing[key] !== input[key])
          throw new ConflictException('Transfer retry terms differ');
      }
      if (existing.expiresAt.getTime() !== input.expiresAt.getTime())
        throw new ConflictException('Transfer retry expiry differs');
      // Revalidate freshness and expiry on a retry, rather than returning stale
      // confirmation/acceptance as if it were still actionable.
      return tx.ownershipTransferIntent.update({
        where: { id: existing.id },
        data: { status: existing.status },
      });
    }
    // PostgreSQL validates freshness, tenant, eligibility and server-clock expiry.
    return this.intents.create(tx, input);
  }

  async respondWithinTransaction(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      intentId: string;
      participantMembershipId: string;
      expectedOwnershipRevision: number;
      expectedIntentRevision: number;
      response: 'ACCEPTED' | 'CANCELLED';
    },
  ) {
    await this.members.lockWorkspace(
      tx,
      input.workspaceId,
      input.expectedOwnershipRevision,
    );
    const preview = await tx.ownershipTransferIntent.findUnique({
      where: { id: input.intentId, workspaceId: input.workspaceId },
    });
    if (!preview) throw new ConflictException('Transfer intent not found');
    await this.members.lockMembers(tx, input.workspaceId, [
      preview.currentOwnerMembershipId,
      preview.targetMembershipId,
    ]);
    const intent = await this.intents.lock(
      tx,
      input.workspaceId,
      input.intentId,
    );
    if (intent.revision !== input.expectedIntentRevision)
      throw new ConflictException('Transfer intent revision changed');
    const participant = input.participantMembershipId;
    if (
      input.response === 'ACCEPTED'
        ? participant !== intent.targetMembershipId
        : participant !== intent.targetMembershipId &&
          participant !== intent.currentOwnerMembershipId
    ) {
      throw new ConflictException('Response does not match bound participant');
    }
    return this.intents.setStatus(
      tx,
      input.workspaceId,
      intent.id,
      intent.revision,
      input.response,
    );
  }

  execute(): never {
    throw new ServiceUnavailableException(
      'Transfer execution requires authorization, capability/scope, assignment, entitlement and audit integration',
    );
  }
}
