import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { installTenantContext } from '../provider-tenancy/tenant-context';
import type { SessionAuthority } from './domain/authorization.types';
import { captureHumanAuthority } from './domain/authority-reference';
import type { GlobalAuthorityReader } from './persistence/global-authority.reader';
import type { AuthorityLockRepository } from './persistence/authority-lock.repository';

export type InvitationRoute = {
  invitation_id: string;
  workspace_id: string;
  issuer_membership_id: string;
  issuer_user_id: string;
  ownership_revision: number;
};
export async function invitationRoute(
  tx: Prisma.TransactionClient,
  a: SessionAuthority,
  hash: string,
) {
  const [user] = await tx.$queryRaw<
    { email_verified: boolean }[]
  >`SELECT email_verified FROM users WHERE id=${a.userId}::uuid`;
  if (!user?.email_verified)
    throw new ConflictException({
      code: 'EMAIL_VERIFICATION_REQUIRED',
      message: 'Verify your account email',
    });
  const [route] = await tx.$queryRaw<
    InvitationRoute[]
  >`SELECT * FROM lookup_workspace_invitation(${hash},${a.userId}::uuid,${a.sessionId},${a.authVersion})`;
  if (!route)
    throw new NotFoundException({
      code: 'INVITATION_UNAVAILABLE',
      message: 'Invitation unavailable',
    });
  return route;
}
// Closed admission seam: no arbitrary tenant producer/mutation callback.
export async function acceptInvitationTransaction(
  db: PrismaService,
  locks: AuthorityLockRepository,
  global: GlobalAuthorityReader,
  a: SessionAuthority,
  hash: string,
  commandId: string,
) {
  const principal = captureHumanAuthority(a);
  if (principal.mode !== 'SESSION_BOUND') throw new UnauthorizedException();
  const route = await db.$transaction(async (tx) => {
    await global.assert(tx, principal);
    return invitationRoute(tx, principal, hash);
  });
  const memberId = randomUUID();
  return runSerializableTransaction(db, async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout='1500ms'`;
    await locks.global(tx, principal, [route.issuer_user_id]);
    await global.assert(tx, principal);
    const current = await invitationRoute(tx, principal, hash);
    if (
      current.workspace_id !== route.workspace_id ||
      current.issuer_user_id !== route.issuer_user_id ||
      current.invitation_id !== route.invitation_id
    )
      throw new NotFoundException('Invitation unavailable');
    await installTenantContext(tx, current.workspace_id);
    await locks.workspace(tx, current.workspace_id, {
      kind: 'STRUCTURAL',
      expectedOwnershipRevision: current.ownership_revision,
      membershipIds: [],
    });
    await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE workspace_id=${current.workspace_id}::uuid AND (id=${current.issuer_membership_id}::uuid OR user_id=${principal.userId}::uuid) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT r.id FROM workspace_seat_reservations r JOIN workspace_invitations i ON i.reservation_id=r.id AND i.workspace_id=r.workspace_id WHERE i.id=${current.invitation_id}::uuid FOR UPDATE OF r`;
    await tx.$queryRaw`SELECT id FROM workspace_invitations WHERE id=${current.invitation_id}::uuid FOR UPDATE`;
    await global.assertSession(tx, principal);
    const [admitted] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT admit_workspace_invitation(${current.invitation_id}::uuid,${principal.userId}::uuid,${hash},${commandId}::uuid,${memberId}::uuid) AS id`;
    return tx.workspaceMembership.findUniqueOrThrow({
      where: { id: admitted.id, workspaceId: current.workspace_id },
      select: { id: true, workspaceId: true, role: true, status: true },
    });
  });
}
