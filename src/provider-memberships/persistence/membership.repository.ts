import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Prisma,
  WorkspaceMembershipStatus,
} from '../../generated/prisma/client';

@Injectable()
export class MembershipRepository {
  async lockWorkspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    expectedOwnershipRevision: number,
  ) {
    // Actual parent write, not SELECT FOR UPDATE: captures the ownership baseline
    // before any child tuple lock, and rejects stale competing ownership changes.
    await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${workspaceId}::uuid, ${expectedOwnershipRevision}::integer)`;
    const w = await tx.providerWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    if (w.lifecycleStatus !== 'ACTIVE')
      throw new ConflictException('Workspace is not active');
    return w;
  }

  async lockMembers(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    ids: string[],
  ) {
    // ORDER BY in SQL is authoritative (UUID ordering), independent of input order.
    await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE workspace_id=${workspaceId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const members = await tx.workspaceMembership.findMany({
      where: { workspaceId, id: { in: ids } },
    });
    if (members.length !== new Set(ids).size)
      throw new NotFoundException('Workspace membership not found');
    return members;
  }

  setStatus(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    id: string,
    revision: number,
    status: WorkspaceMembershipStatus,
  ) {
    return tx.workspaceMembership.update({
      where: { id, workspaceId, revision },
      data: { status },
    });
  }
}
