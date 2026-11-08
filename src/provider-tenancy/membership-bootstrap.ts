import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';
import {
  installMembershipBootstrap,
  installTenantContext,
} from './tenant-context';

@Injectable()
export class MembershipBootstrap {
  constructor(private readonly global: GlobalAuthorityReader) {}

  async enter(
    tx: Prisma.TransactionClient,
    authority: HumanAuthority,
    workspaceId: string,
  ) {
    await this.global.assert(tx, authority);
    await installMembershipBootstrap(tx, authority.userId, workspaceId);
    const member = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: authority.userId } },
      select: { id: true, status: true },
    });
    if (!member || member.status !== 'ACTIVE')
      throw new NotFoundException('Workspace not found');
    await installTenantContext(tx, workspaceId);
    return member.id;
  }
}
