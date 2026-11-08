import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { captureHumanAuthority } from '../provider-authorization/domain/authority-reference';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';
import { WorkspaceEstablishment } from '../provider-workspaces/workspace-establishment';
import { installTenantContext } from './tenant-context';

type Creation = { displayName: string } & (
  { kind: 'PERSONAL' } | { kind: 'ORGANIZATION'; legalName: string | null }
);

// No endpoint/default eligibility policy. Later onboarding owns anti-abuse,
// entitlements and audit. IDs are generated here and stable across DB retries.
@Injectable()
export class WorkspaceCreation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AuthorityLockRepository,
    private readonly global: GlobalAuthorityReader,
    private readonly establishment: WorkspaceEstablishment,
  ) {}

  run(
    authority: HumanAuthority,
    input: Creation,
    eligibility: (
      tx: Prisma.TransactionClient,
      userId: string,
    ) => Promise<void>,
  ) {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND')
      throw new Error('Creation requires authenticated session authority');
    const command = {
      ...input,
      userId: principal.userId,
      workspaceId: randomUUID(),
      membershipId: randomUUID(),
      allocationId: randomUUID(),
    };
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.locks.global(tx, principal);
      await this.global.assert(tx, principal);
      await eligibility(tx, principal.userId);
      await installTenantContext(tx, command.workspaceId);
      await this.global.assertSession(tx, principal);
      return this.establishment.withinTransaction(tx, command);
    });
  }
}
