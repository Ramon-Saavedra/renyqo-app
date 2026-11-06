import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class MembershipIdentityRepository {
  findOwner(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspaceMembership.findFirst({
      where: { workspaceId, role: 'OWNER' },
    });
  }

  establishOwner(
    tx: Prisma.TransactionClient,
    data: {
      id: string;
      workspaceId: string;
      userId: string;
      displayColor: string;
    },
  ) {
    return tx.workspaceMembership.create({ data: { ...data, role: 'OWNER' } });
  }
}
