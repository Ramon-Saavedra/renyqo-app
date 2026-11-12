import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { ListingEligibilityState } from '../eligibility/profile-eligibility-evaluator';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { captureHumanAuthority } from '../provider-authorization/domain/authority-reference';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';

// A single approved cross-workspace operation. It never installs or switches
// ordinary tenant context and returns only the locked eligibility inputs.
@Injectable()
export class ProfileRevalidationTransactions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AuthorityLockRepository,
    private readonly global: GlobalAuthorityReader,
  ) {}

  run<T>(
    authority: HumanAuthority,
    mutate: (
      tx: Prisma.TransactionClient,
      listings: readonly ListingEligibilityState[],
    ) => Promise<T>,
  ) {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND')
      throw new ForbiddenException('Applicant session required');
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        await this.locks.global(tx, principal);
        await this.global.assert(tx, principal);
        const user = await tx.user.findUnique({
          where: { id: principal.userId },
          select: { role: true },
        });
        if (user?.role !== 'APPLICANT')
          throw new ForbiddenException('Applicant authority required');
        // The helper locks all sorted workspace roots before all sorted listings.
        const listings = await tx.$queryRaw<ListingEligibilityState[]>`
        SELECT * FROM lock_profile_revalidation_listings(${principal.userId}::uuid)`;
        await this.global.assertSession(tx, principal);
        return mutate(tx, listings);
      },
      { fallbackMessage: 'Profile update could not be completed' },
    );
  }
}
