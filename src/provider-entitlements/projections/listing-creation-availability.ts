import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import { allowsProviderOperation } from '../../provider-authorization/capabilities/provider-capability-policy';
import { providerDefaultCapabilities } from '../../provider-authorization/capabilities/provider-default-capabilities';
import { assertAcquisition } from '../capacity/capacity.policy';
import { EntitlementResolver } from '../resolution/entitlement-resolver';

export type ListingCreationAvailability =
  | { allowed: true; reason: null }
  | {
      allowed: false;
      reason: 'NOT_PERMITTED' | 'WORKSPACE_GROWTH_UNAVAILABLE';
    };

@Injectable()
export class ListingCreationAvailabilityProjection {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async project(
    tx: Prisma.TransactionClient,
    context: AuthorizationContext,
  ): Promise<ListingCreationAvailability> {
    if (
      !allowsProviderOperation(
        providerDefaultCapabilities(context),
        'listing.create',
      )
    )
      return { allowed: false, reason: 'NOT_PERMITTED' };

    // Tenant-wide counts, never the actor's responsible-listing filter.
    const capacity = await this.entitlements.resolve(tx, context.workspaceId);
    try {
      assertAcquisition(capacity, 'LISTING');
    } catch (error) {
      if (error instanceof ConflictException) {
        const code = (error.getResponse() as { code?: string }).code;
        if (
          code === 'PLAN_UNAVAILABLE' ||
          code === 'WORKSPACE_OVER_LIMIT' ||
          code === 'LISTING_LIMIT_REACHED'
        )
          return { allowed: false, reason: 'WORKSPACE_GROWTH_UNAVAILABLE' };
      }
      throw error;
    }
    return { allowed: true, reason: null };
  }
}
