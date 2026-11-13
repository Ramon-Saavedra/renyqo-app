import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { providerApplicationIsVisible } from '../applications/application-process.policy';
import type { Prisma } from '../generated/prisma/client';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
import {
  ProviderListingAccess,
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
