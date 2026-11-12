import type { PrismaClient } from '../src/generated/prisma/client';
import type {
  AuthorizationContext,
  HumanAuthority,
} from '../src/provider-authorization/domain/authorization.types';
import type { ProviderActor } from '../src/provider-authorization/provider-listing-access';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  ensurePersonalWorkspaceForProvider,
  resolveProviderWorkspace,
} from './e2e-workspace-listing';

type WorkspaceDb = PrismaService | PrismaClient;

type HeaderAgent = { set: (field: string, value: string) => unknown };

async function resolveSessionIdForUser(
  prisma: WorkspaceDb,
  userId: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ sid: string }[]>`
    SELECT sid FROM session_auth_grants WHERE user_id = ${userId}::uuid LIMIT 1`;
  if (rows[0]?.sid) return rows[0].sid;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, authVersion: true },
  });
  const sid = `e2e-${userId}`;
  const expire = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const sess = {
    cookie: {
      originalMaxAge: 604_800_000,
      expires: expire.toISOString(),
    },
    passport: {
      user: {
        id: user.id,
        authVersion: user.authVersion,
      },
    },
  };
  await prisma.$executeRaw`
    INSERT INTO user_sessions (sid, sess, expire)
    VALUES (${sid}, ${JSON.stringify(sess)}::json, ${expire})
    ON CONFLICT (sid) DO NOTHING`;
  await prisma.$executeRaw`
    INSERT INTO session_auth_grants (sid, user_id, auth_version)
    VALUES (${sid}, ${user.id}::uuid, ${user.authVersion}::integer)
    ON CONFLICT (sid) DO NOTHING`;
  return sid;
}

/** Provider HTTP routes resolve workspace from `x-workspace-id` (404 when absent). */
export async function bindProviderWorkspaceHeader(
  prisma: WorkspaceDb,
  providerUserId: string,
  agent: HeaderAgent,
): Promise<string> {
  const { workspaceId } = await ensurePersonalWorkspaceForProvider(
    prisma,
    providerUserId,
  );
  agent.set('x-workspace-id', workspaceId);
  return workspaceId;
}

export async function providerActorFor(
  prisma: WorkspaceDb,
  providerUserId: string,
  sessionId?: string,
): Promise<ProviderActor> {
  await ensurePersonalWorkspaceForProvider(prisma, providerUserId);
  const { workspaceId } = await resolveProviderWorkspace(
    prisma,
    providerUserId,
  );
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: providerUserId },
    select: { id: true, authVersion: true },
  });
  const sid =
    sessionId ?? (await resolveSessionIdForUser(prisma, providerUserId));
  return {
    authority: {
      mode: 'SESSION_BOUND',
      userId: user.id,
      authVersion: user.authVersion,
      sessionId: sid,
    },
    workspaceId,
  };
}

export async function authorizationContextFor(
  prisma: WorkspaceDb,
  providerUserId: string,
  sessionId?: string,
): Promise<AuthorizationContext> {
  await ensurePersonalWorkspaceForProvider(prisma, providerUserId);
  const membership = await prisma.workspaceMembership.findFirstOrThrow({
    where: { userId: providerUserId, role: 'OWNER', status: 'ACTIVE' },
    include: {
      workspace: {
        select: { lifecycleStatus: true, ownershipRevision: true },
      },
      user: { select: { authVersion: true } },
    },
  });
  const sid =
    sessionId ?? (await resolveSessionIdForUser(prisma, providerUserId));
  return {
    mode: 'SESSION_BOUND',
    userId: providerUserId,
    authVersion: membership.user.authVersion,
    sessionId: sid,
    workspaceId: membership.workspaceId,
    membershipId: membership.id,
    role: membership.role,
    status: 'ACTIVE',
    membershipRevision: membership.revision,
    workspaceLifecycle: membership.workspace.lifecycleStatus,
    ownershipRevision: membership.workspace.ownershipRevision,
  };
}

export async function applicantAuthorityFor(
  prisma: WorkspaceDb,
  applicantUserId: string,
  sessionId?: string,
): Promise<HumanAuthority> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: applicantUserId },
    select: { id: true, authVersion: true },
  });
  const sid =
    sessionId ?? (await resolveSessionIdForUser(prisma, applicantUserId));
  return {
    mode: 'SESSION_BOUND',
    userId: user.id,
    authVersion: user.authVersion,
    sessionId: sid,
  };
}
