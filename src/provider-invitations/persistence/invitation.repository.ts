import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import {
  invitationConflict,
  invitationMissing,
} from '../domain/invitation-errors';
export type InvitationCommand = {
  workspaceId: string;
  commandId: string;
  kind: 'CREATE' | 'RESEND' | 'REVOKE' | 'EXPIRE';
  actorUserId: string;
  inputHash: string;
};
@Injectable()
export class InvitationRepository {
  async replay(tx: Prisma.TransactionClient, input: InvitationCommand) {
    const prior = await tx.workspaceInvitationCommand.findUnique({
      where: {
        workspaceId_commandId: {
          workspaceId: input.workspaceId,
          commandId: input.commandId,
        },
      },
    });
    if (!prior) return null;
    if (
      prior.actorUserId !== input.actorUserId ||
      prior.kind !== input.kind ||
      prior.inputHash !== input.inputHash
    )
      invitationConflict('INVITATION_COMMAND_CONFLICT');
    return this.find(tx, input.workspaceId, prior.invitationId);
  }
  async find(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
    const row = await tx.workspaceInvitation.findUnique({
      where: { id, workspaceId },
    });
    if (!row) invitationMissing();
    return row;
  }
  record(
    tx: Prisma.TransactionClient,
    input: InvitationCommand,
    invitationId: string,
    resultRevision: number,
  ) {
    return tx.workspaceInvitationCommand.create({
      data: { ...input, invitationId, resultRevision },
    });
  }
  async clock(tx: Prisma.TransactionClient) {
    return (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now;
  }
}
