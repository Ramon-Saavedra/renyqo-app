import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  providerApplicationIsVisible,
  providerApplicationVisibility,
} from '../applications/application-process.policy';
import type { Prisma } from '../generated/prisma/client';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
import {
  ProviderListingAccess,
  providerListingWhere,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import {
  ApplicantListingAccess,
  type ApplicantListingPolicy,
} from './applicant-listing-access';

export type ApplicationActor = ProviderActor | HumanAuthority;
export function actorUserId(actor: ApplicationActor) {
  return 'authority' in actor ? actor.authority.userId : actor.userId;
}

// Listing scope only. Each domain retains its resource eligibility policy.
@Injectable()
export class ApplicationListingAccess {
  constructor(
    private readonly provider: ProviderListingAccess,
    private readonly applicant: ApplicantListingAccess,
  ) {}

  assertActor(actor: ApplicationActor, audience: 'provider' | 'applicant') {
    if (audience === 'provider') {
      if (!('authority' in actor))
        throw new ForbiddenException('Explicit provider context required');
      return this.provider.read(
        actor,
        'application.read',
        undefined,
        async () => {},
      );
    }
    if ('authority' in actor)
      throw new ForbiddenException('Explicit applicant session required');
    return this.applicant.assertPrincipal(actor);
  }

  // References come from server-produced results, including totals and headers,
  // not client selectors. Revalidate the complete result in one fresh scope.
  async assertResultScope(
    actor: ApplicationActor,
    audience: 'provider' | 'applicant',
    applications: readonly { applicationId: string; listingId: string }[],
    listingIds: readonly string[] = [],
  ): Promise<void> {
    if (audience === 'applicant') return this.assertActor(actor, audience);
    if (!('authority' in actor))
      throw new ForbiddenException('Explicit provider context required');
    const references = applications.map((row) => ({ ...row }));
    const ids = [...new Set(references.map((row) => row.applicationId))];
    const listings = [
      ...new Set([...listingIds, ...references.map((row) => row.listingId)]),
    ];
    await this.provider.read(
      actor,
      'application.read',
      undefined,
      async (tx, context) => {
        if (
          listings.length &&
          (await tx.listing.count({
            where: { id: { in: listings }, ...providerListingWhere(context) },
          })) !== listings.length
        )
          throw new NotFoundException('Listing not found');
        const rows = ids.length
          ? await tx.application.findMany({
              where: {
                id: { in: ids },
                ...providerApplicationVisibility(context),
              },
              select: { id: true, listingId: true },
            })
          : [];
        const current = new Map(rows.map((row) => [row.id, row.listingId]));
        if (
          references.some(
            (row) => current.get(row.applicationId) !== row.listingId,
          )
        )
          throw new NotFoundException('Application not found');
      },
    );
  }

  read<T>(
    actor: ApplicationActor,
    audience: 'provider' | 'applicant',
    id: string,
    policy: ApplicantListingPolicy,
    produce: (
      tx: Prisma.TransactionClient,
      listingId: string,
      context?: AuthorizationContext,
    ) => Promise<T>,
  ) {
    if (audience === 'provider') {
      if (!('authority' in actor))
        throw new ForbiddenException('Explicit provider context required');
      return this.provider.readApplication(
        actor,
        'application.read',
        id,
        async (tx, listingId) => {
          const app = await tx.application.findUnique({
            where: { id },
            select: { status: true, activeAt: true },
          });
          if (!app || !providerApplicationIsVisible(app))
            throw new NotFoundException('Application not found');
          await policy(tx, listingId);
        },
        produce,
      );
    }
    if ('authority' in actor)
      throw new ForbiddenException('Explicit applicant session required');
    return this.applicant.readApplication(actor, id, policy, produce);
  }

  mutate<T>(
    actor: ApplicationActor,
    audience: 'provider' | 'applicant',
    id: string,
    policy: ApplicantListingPolicy,
    mutate: (tx: Prisma.TransactionClient, listingId: string) => Promise<T>,
  ) {
    if (audience === 'provider') {
      if (!('authority' in actor))
        throw new ForbiddenException('Explicit provider context required');
      return this.provider.mutateApplication(
        actor,
        'application.write',
        id,
        async (tx, listingId) => {
          await policy(tx, listingId);
          return mutate(tx, listingId);
        },
      );
    }
    if ('authority' in actor)
      throw new ForbiddenException('Explicit applicant session required');
    return this.applicant.mutateApplication(actor, id, policy, mutate);
  }
}
