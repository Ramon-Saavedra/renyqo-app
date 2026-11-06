import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class PersonalAllocationRepository {
  find(tx: Prisma.TransactionClient, id: string) {
    return tx.personalWorkspaceAllocation.findUnique({ where: { id } });
  }

  allocate(
    tx: Prisma.TransactionClient,
    data: {
      id: string;
      workspaceId: string;
      userId: string;
    },
  ) {
    // Occupancy only. Eligibility/anti-abuse approval belongs to the caller.
    return tx.personalWorkspaceAllocation.create({ data });
  }
}
