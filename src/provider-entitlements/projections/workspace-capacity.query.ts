import { ConflictException, Injectable } from '@nestjs/common';
import { AuthorizedWorkspaceReads } from '../../provider-authorization/authorized-workspace-reads';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import { EntitlementResolver } from '../resolution/entitlement-resolver';
import { assertAcquisition } from '../capacity/capacity.policy';
@Injectable()
export class WorkspaceCapacityQuery {
  constructor(
    private readonly reads: AuthorizedWorkspaceReads,
    private readonly resolver: EntitlementResolver,
  ) {}
  run(actor: ProviderActor) {
    return this.reads.query(
      actor.authority,
      {
        workspaceId: actor.workspaceId,
        action: 'plan.capacity.read',
        resourceIds: [],
        purpose: 'OPERATIONAL',
        requiredRole: 'OWNER',
      },
      () => Promise.resolve(),
      async (_ctx, tx) => {
        const s = await this.resolver.resolve(tx, actor.workspaceId);
        function availability(kind: 'LISTING' | 'SEAT') {
          try {
            assertAcquisition(s, kind);
            return { allowed: true, reason: null };
          } catch (error) {
            if (error instanceof ConflictException)
              return {
                allowed: false,
                reason: (error.getResponse() as { code: string }).code,
              };
            throw error;
          }
        }
        return {
          ...s,
          remainingListings: Math.max(0, s.maxListings - s.usedListings),
          remainingSeats: Math.max(
            0,
            s.maxSeats - s.acceptedSeats - s.reservedSeats,
          ),
          actions: {
            createListing: availability('LISTING'),
            reserveSeat: availability('SEAT'),
          },
        };
      },
    );
  }
}
