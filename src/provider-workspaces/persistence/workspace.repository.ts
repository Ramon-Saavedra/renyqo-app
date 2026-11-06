import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class WorkspaceRepository {
  async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM provider_workspaces WHERE id = ${id}::uuid FOR UPDATE`;
    const workspace = await tx.providerWorkspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  find(tx: Prisma.TransactionClient, id: string) {
    return tx.providerWorkspace.findUnique({ where: { id } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.ProviderWorkspaceCreateInput,
  ) {
    return tx.providerWorkspace.create({ data });
  }

  convert(tx: Prisma.TransactionClient, id: string, revision: number) {
    return tx.providerWorkspace.update({
      where: { id, revision },
      data: { kind: 'ORGANIZATION', revision: { increment: 1 } },
    });
  }

  beginClosing(tx: Prisma.TransactionClient, id: string, revision: number) {
    return tx.providerWorkspace.update({
      where: { id, revision },
      data: {
        lifecycleStatus: 'CLOSING',
        closingAt: new Date(),
        revision: { increment: 1 },
      },
    });
  }

  completeClosure(tx: Prisma.TransactionClient, id: string, revision: number) {
    // PostgreSQL releases all open allocations in this same transaction.
    return tx.providerWorkspace.update({
      where: { id, revision },
      data: {
        lifecycleStatus: 'CLOSED',
        closedAt: new Date(),
        revision: { increment: 1 },
      },
    });
  }
}
