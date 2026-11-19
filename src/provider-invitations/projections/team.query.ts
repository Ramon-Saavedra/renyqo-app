import { Injectable } from '@nestjs/common';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import { AuthorizedWorkspaceReads } from '../../provider-authorization/authorized-workspace-reads';
import { EntitlementResolver } from '../../provider-entitlements/resolution/entitlement-resolver';
import { SecurityLinkPolicy } from '../../security/security-link-policy';
import { invitationDto } from './invitation.dto';
@Injectable()
export class TeamQuery {
  constructor(
    private readonly reads: AuthorizedWorkspaceReads,
    private readonly entitlements: EntitlementResolver,
    private readonly policy: SecurityLinkPolicy,
  ) {}
  run(actor: ProviderActor, page: number, limit: number) {
    return this.reads.query(
      actor.authority,
      {
        workspaceId: actor.workspaceId,
        action: 'team.read',
        resourceIds: [],
        purpose: 'OPERATIONAL',
        requiredRole: 'OWNER',
      },
      () => Promise.resolve(),
      async (ctx, tx) => {
        const where = { workspaceId: ctx.workspaceId };
        const members = await tx.workspaceMembership.findMany({
          where,
          include: { user: { select: { name: true, email: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        });
        const invitations = await tx.workspaceInvitation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        });
        const counts = await tx.listing.groupBy({
          by: ['responsibleMembershipId'],
          where: {
            ...where,
            status: { not: 'RETIRED' },
            responsibleMembershipId: { in: members.map((m) => m.id) },
          },
          _count: true,
        });
        const joined = await tx.workspaceInvitation.findMany({
          where: {
            ...where,
            acceptedMembershipId: { in: members.map((m) => m.id) },
            acceptanceKind: 'CREATED',
          },
          select: { acceptedMembershipId: true, acceptedAt: true },
        });
        const capacity = await this.entitlements.resolve(tx, ctx.workspaceId);
        const [{ now }] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT clock_timestamp() AS now`;
        return {
          page,
          limit,
          members: members.map((m) => ({
            id: m.id,
            membershipId: m.id,
            name: m.user.name,
            email: m.user.email,
            role: m.role,
            status: m.status,
            colorId: m.displayColor,
            joinedAt:
              joined.find((i) => i.acceptedMembershipId === m.id)?.acceptedAt ??
              m.createdAt,
            joinedVia: joined.some((i) => i.acceptedMembershipId === m.id)
              ? 'INVITATION'
              : 'ESTABLISHED',
            assignedListingCount:
              counts.find((c) => c.responsibleMembershipId === m.id)?._count ??
              0,
            actions: {
              canSuspend: false,
              canResume: false,
              canRemove: false,
              canReinstate: false,
            },
          })),
          invitations: invitations.map((i) =>
            invitationDto(i, now, ctx.membershipId, this.policy.resendCooldown),
          ),
          memberTotal: await tx.workspaceMembership.count({ where }),
          invitationTotal: await tx.workspaceInvitation.count({ where }),
          capacity: {
            acceptedSeats: capacity.acceptedSeats,
            reservedSeats: capacity.reservedSeats,
            maxSeats: capacity.maxSeats,
            remainingSeats: Math.max(
              0,
              capacity.maxSeats -
                capacity.acceptedSeats -
                capacity.reservedSeats,
            ),
            overLimit: capacity.overLimit,
            assigned: capacity.assigned,
          },
          actions: {
            canInvite:
              capacity.assigned &&
              capacity.overLimit.length === 0 &&
              capacity.acceptedSeats + capacity.reservedSeats <
                capacity.maxSeats,
          },
        };
      },
    );
  }
}
