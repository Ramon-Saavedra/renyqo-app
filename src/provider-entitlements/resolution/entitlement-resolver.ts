import { Injectable, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  CapacitySnapshot,
  EntitlementFeature,
} from '../catalog/entitlement.types';
import { resolveFeatures } from '../catalog/entitlement-features';

@Injectable()
export class EntitlementResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<CapacitySnapshot> {
    const assignment = await tx.workspacePlanAssignment.findUniqueOrThrow({
      where: { workspaceId },
      include: { planVersion: true, workspace: { select: { kind: true } } },
    });
    const usedListings = await tx.listing.count({
      where: { workspaceId, status: { not: 'RETIRED' } },
    });
    const acceptedSeats = await tx.workspaceMembership.count({
      where: { workspaceId, status: { not: 'REMOVED' } },
    });
    const [{ count }] = await tx.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM workspace_seat_reservations WHERE workspace_id=${workspaceId}::uuid AND released_at IS NULL AND expires_at>clock_timestamp()`;
    const p = assignment.planVersion;
    const personal = assignment.workspace.kind === 'PERSONAL';
    const maxListings = p
      ? personal
        ? Math.min(1, p.maxListings)
        : p.maxListings
      : 0;
    const maxSeats = p ? (personal ? Math.min(1, p.maxSeats) : p.maxSeats) : 0;
    const reservedSeats = Number(count);
    return {
      assigned: !!p,
      assignmentRevision: assignment.revision,
      plan: p ? { id: p.id, key: p.planKey, version: p.version } : null,
      maxListings,
      maxSeats,
      usedListings,
      acceptedSeats,
      reservedSeats,
      features: resolveFeatures(p?.features ?? []),
      overLimit: p
        ? [
            ...(usedListings > maxListings ? ['LISTINGS' as const] : []),
            ...(acceptedSeats + reservedSeats > maxSeats
              ? ['SEATS' as const]
              : []),
          ]
        : [],
    };
  }
  assertFeature(snapshot: CapacitySnapshot, feature: EntitlementFeature): void {
    if (!snapshot.assigned || !snapshot.features.includes(feature))
      throw new ForbiddenException({
        code: 'FEATURE_NOT_ENTITLED',
        message: 'Feature not entitled',
      });
  }
}
