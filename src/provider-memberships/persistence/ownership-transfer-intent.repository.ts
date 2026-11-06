import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class OwnershipTransferIntentRepository {
  async lock(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM ownership_transfer_intents WHERE workspace_id=${workspaceId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const intent = await tx.ownershipTransferIntent.findUnique({
      where: { id, workspaceId },
    });
    if (!intent) throw new NotFoundException('Transfer intent not found');
    return intent;
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.OwnershipTransferIntentUncheckedCreateInput,
  ) {
    return tx.ownershipTransferIntent.create({ data });
  }

  setStatus(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    id: string,
    revision: number,
    status: 'ACCEPTED' | 'CANCELLED',
  ) {
    return tx.ownershipTransferIntent.update({
      where: { id, workspaceId, revision },
      data: { status },
    });
  }
}
