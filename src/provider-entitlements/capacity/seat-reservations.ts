import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { EntitlementResolver } from '../resolution/entitlement-resolver';
import { assertAcquisition, capacityConflict } from './capacity.policy';
@Injectable()
export class SeatReservations {
  constructor(private readonly entitlements: EntitlementResolver) {}
  async reserve(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      id: string;
      commandId: string;
      expiresAt: Date;
    },
  ) {
    const previous = await tx.workspaceSeatReservation.findUnique({
      where: {
        workspaceId_commandId: {
          workspaceId: input.workspaceId,
          commandId: input.commandId,
        },
      },
    });
    if (previous) {
      if (
        previous.id !== input.id ||
        previous.expiresAt.getTime() !== input.expiresAt.getTime()
      )
        capacityConflict('SEAT_RESERVATION_CONFLICT');
      return previous;
    }
    assertAcquisition(
      await this.entitlements.resolve(tx, input.workspaceId),
      'SEAT',
    );
    return tx.workspaceSeatReservation.create({ data: input });
  }
  async release(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
    await tx.workspaceSeatReservation.updateMany({
      where: { workspaceId, id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    return tx.workspaceSeatReservation.findUniqueOrThrow({
      where: { id, workspaceId },
    });
  }
}
