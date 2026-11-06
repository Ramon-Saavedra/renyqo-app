import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class OrganizationProfileRepository {
  find(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.organizationProfile.findUnique({ where: { workspaceId } });
  }

  create(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    legalName: string | null,
  ) {
    return tx.organizationProfile.create({ data: { workspaceId, legalName } });
  }
}
