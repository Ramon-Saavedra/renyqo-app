import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ProtectedWorkspaceTransactions } from '../../provider-authorization/protected-workspace-transactions';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  AuthorityLockPlan,
  HumanAuthority,
  WritePolicy,
} from '../../provider-authorization/domain/authorization.types';
import { auditedWork } from './audited-work';

// Optional audit completion adapter, not a second transaction/locking framework.
// Domain adapters still own policy, receipt replay, mutations and effect binding.
@Injectable()
export class AuditedWorkspaceTransactions {
  constructor(private readonly writes: ProtectedWorkspaceTransactions) {}
  run<T>(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    plan: AuthorityLockPlan,
    policy: WritePolicy,
    mutate: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
      requirement: AuthorizationRequirement,
    ) => Promise<T>,
  ) {
    return this.writes.run(
      authority,
      requirement,
      plan,
      policy,
      (tx, context, selection) =>
        auditedWork(tx, () => mutate(tx, context, selection)),
    );
  }
}
