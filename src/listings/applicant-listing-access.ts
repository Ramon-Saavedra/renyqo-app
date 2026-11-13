import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { captureHumanAuthority } from '../provider-authorization/domain/authority-reference';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';
import { installTenantContext } from '../provider-tenancy/tenant-context';

interface ListingRoute {
  listing_id: string;
  workspace_id: string;
}
export type ApplicantListingPolicy = (
  tx: Prisma.TransactionClient,
  listingId: string,
) => Promise<void>;

// A bounded consumer adapter, not provider membership or generic applicant auth.
@Injectable()
export class ApplicantListingAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly global: GlobalAuthorityReader,
    private readonly locks: AuthorityLockRepository,
  ) {}

  assertPrincipal(authority: HumanAuthority) {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND')
      throw new ForbiddenException('Applicant HTTP session authority required');
    return this.prisma.$transaction(
      async (tx) => {
        await this.global.assert(tx, principal);
        const user = await tx.user.findUnique({
          where: { id: principal.userId },
          select: { role: true },
        });
        if (user?.role !== 'APPLICANT')
          throw new ForbiddenException('Applicant authority required');
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async readApplication<T>(
    authority: HumanAuthority,
    applicationId: string,
    policy: ApplicantListingPolicy,
    produce: (tx: Prisma.TransactionClient, listingId: string) => Promise<T>,
  ) {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND')
      throw new ForbiddenException('Applicant HTTP session authority required');
    const snapshot = await this.prisma.$transaction(
      async (tx) => {
        await this.global.assert(tx, principal);
        const route = await this.route(
          tx,
          principal.userId,
          applicationId,
          false,
        );
        await installTenantContext(tx, route.workspace_id);
        await this.assertOwnedApplication(
          tx,
          principal.userId,
          applicationId,
          route,
        );
        await policy(tx, route.listing_id);
        const result = await produce(tx, route.listing_id);
        return { route, value: result };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    await this.prisma.$transaction(
      async (tx) => {
        await this.global.assert(tx, principal);
        const current = await this.route(
          tx,
          principal.userId,
          applicationId,
          false,
        );
        if (
          current.listing_id !== snapshot.route.listing_id ||
          current.workspace_id !== snapshot.route.workspace_id
        )
          throw new NotFoundException('Application not found');
        await installTenantContext(tx, current.workspace_id);
        await this.assertOwnedApplication(
          tx,
          principal.userId,
          applicationId,
          current,
        );
        await policy(tx, current.listing_id);
      },
      { isolationLevel: 'ReadCommitted' },
    );
    return snapshot.value;
  }

  mutateApplication<T>(
    authority: HumanAuthority,
    applicationId: string,
    policy: ApplicantListingPolicy,
    mutate: (tx: Prisma.TransactionClient, listingId: string) => Promise<T>,
  ) {
    return this.mutation(authority, applicationId, false, policy, mutate);
  }

  // Admission is the public-resource exception: it creates the FIRST Application,
  // never exposes private Listing data merely because a Listing UUID is known.
  admit<T>(
    authority: HumanAuthority,
    listingId: string,
    policy: ApplicantListingPolicy,
    mutate: (tx: Prisma.TransactionClient, listingId: string) => Promise<T>,
  ) {
    return this.mutation(authority, listingId, true, policy, mutate);
  }

  private mutation<T>(
    authority: HumanAuthority,
    selector: string,
    admission: boolean,
    policy: ApplicantListingPolicy,
    mutate: (tx: Prisma.TransactionClient, listingId: string) => Promise<T>,
  ) {
    const principal = captureHumanAuthority(authority);
    if (principal.mode !== 'SESSION_BOUND')
      throw new ForbiddenException('Applicant HTTP session authority required');
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.locks.global(tx, principal);
      await this.global.assert(tx, principal);
      const route = await this.route(tx, principal.userId, selector, admission);
      await installTenantContext(tx, route.workspace_id);
      await tx.$queryRaw`SELECT id FROM provider_workspaces WHERE id=${route.workspace_id}::uuid FOR SHARE`;
      const listing = await tx.listing.findUnique({
        where: { id: route.listing_id, workspaceId: route.workspace_id },
        select: {
          id: true,
          status: true,
          workspace: { select: { lifecycleStatus: true } },
        },
      });
      if (!listing) throw new NotFoundException('Application not found');
      if (listing.workspace.lifecycleStatus !== 'ACTIVE')
        throw new NotFoundException(
          admission ? 'Listing not found' : 'Application not found',
        );
      await tx.$queryRaw`SELECT id FROM listings WHERE id=${route.listing_id}::uuid AND workspace_id=${route.workspace_id}::uuid FOR UPDATE`;
      if (admission) {
        if (
          listing.status !== 'PUBLISHED' ||
          listing.workspace.lifecycleStatus !== 'ACTIVE'
        )
          throw new NotFoundException('Listing not found');
      } else
        await this.assertOwnedApplication(
          tx,
          principal.userId,
          selector,
          route,
        );
      await policy(tx, route.listing_id);
      await this.global.assertSession(tx, principal);
      return mutate(tx, route.listing_id);
    });
  }

  private async route(
    tx: Prisma.TransactionClient,
    userId: string,
    selector: string,
    admission: boolean,
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role !== 'APPLICANT')
      throw new ForbiddenException('Applicant authority required');
    const rows = admission
      ? await tx.$queryRaw<
          ListingRoute[]
        >`SELECT * FROM resolve_public_admission_listing(${selector}::uuid)`
      : await tx.$queryRaw<
          ListingRoute[]
        >`SELECT * FROM resolve_applicant_listing(${userId}::uuid,${selector}::uuid)`;
    if (rows.length !== 1)
      throw new NotFoundException(
        admission ? 'Listing not found' : 'Application not found',
      );
    return rows[0];
  }

  private async assertOwnedApplication(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
    route: ListingRoute,
  ) {
    const row = await tx.application.findFirst({
      where: { id, applicantId: userId, listingId: route.listing_id },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Application not found');
  }
}
