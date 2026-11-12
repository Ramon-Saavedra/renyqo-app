import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionAuthority } from '../provider-authorization/domain/authorization.types';
import { captureHumanAuthority } from '../provider-authorization/domain/authority-reference';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';

export type DiscoverableWorkspace = {
  workspaceId: string;
  membershipId: string;
  role: 'OWNER' | 'AGENT';
  kind: 'PERSONAL' | 'ORGANIZATION';
};

@Injectable()
export class WorkspaceDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly global: GlobalAuthorityReader,
  ) {}

  async list(authority: SessionAuthority): Promise<DiscoverableWorkspace[]> {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND') throw new UnauthorizedException();
    return this.prisma.$transaction(
      async (tx) => {
        await this.global.assert(tx, principal);
        // Session-derived identity only. Results are selectors, never grants:
        // operational routes revalidate their explicitly selected workspace.
        return tx.$queryRaw<DiscoverableWorkspace[]>`
        SELECT * FROM discover_active_workspaces(${principal.userId}::uuid)`;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
