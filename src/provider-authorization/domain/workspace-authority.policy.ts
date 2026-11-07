import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type {
  WorkspaceLifecycle,
  WorkspaceMembershipRole,
  WorkspaceMembershipStatus,
} from '../../generated/prisma/client';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  HumanAuthority,
} from './authorization.types';
import {
  assertDelegatedScope,
  freezeScope,
  isAuthorityId,
  positiveEpoch,
} from './authority-reference';

export type MembershipFacts = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMembershipRole;
  status: WorkspaceMembershipStatus;
  revision: number;
  workspace: { lifecycleStatus: WorkspaceLifecycle; ownershipRevision: number };
};

export function captureRequirement(
  input: AuthorizationRequirement,
): AuthorizationRequirement {
  if (
    !input ||
    !isAuthorityId(input.workspaceId) ||
    (input.expectedMembershipId !== undefined &&
      !isAuthorityId(input.expectedMembershipId))
  )
    throw new NotFoundException('Workspace not found');
  if (
    !input.workspaceId ||
    !['OPERATIONAL', 'HISTORY', 'SECURITY', 'CLOSURE_SETTLEMENT'].includes(
      input.purpose,
    ) ||
    (input.requiredRole !== undefined && input.requiredRole !== 'OWNER') ||
    (input.expectedMembershipRevision !== undefined &&
      !positiveEpoch(input.expectedMembershipRevision)) ||
    (input.expectedOwnershipRevision !== undefined &&
      !positiveEpoch(input.expectedOwnershipRevision))
  )
    throw new ForbiddenException('Invalid authority requirement');
  return Object.freeze({
    ...input,
    ...freezeScope(input),
    workspaceId: input.workspaceId.toLowerCase(),
    ...(input.expectedMembershipId === undefined
      ? {}
      : { expectedMembershipId: input.expectedMembershipId.toLowerCase() }),
  });
}

export function workspaceContext(
  authority: HumanAuthority,
  request: AuthorizationRequirement,
  m: MembershipFacts | null,
): AuthorizationContext {
  assertDelegatedScope(authority, request);
  if (
    !m ||
    m.userId !== authority.userId ||
    m.workspaceId !== request.workspaceId ||
    m.status !== 'ACTIVE' ||
    (request.expectedMembershipId !== undefined &&
      request.expectedMembershipId !== m.id)
  )
    throw new NotFoundException('Workspace not found');
  const expected =
    authority.mode === 'USER_DELEGATED'
      ? authority.membershipRevision
      : request.expectedMembershipRevision;
  if (
    (expected !== undefined && expected !== m.revision) ||
    (request.expectedMembershipRevision !== undefined &&
      request.expectedMembershipRevision !== m.revision) ||
    (authority.mode === 'USER_DELEGATED' && authority.membershipId !== m.id)
  )
    throw new ForbiddenException('Membership authority changed');
  const lifecycle = m.workspace.lifecycleStatus;
  if (
    (lifecycle === 'CLOSING' && request.purpose === 'OPERATIONAL') ||
    (lifecycle === 'CLOSED' &&
      request.purpose !== 'HISTORY' &&
      request.purpose !== 'SECURITY')
  )
    throw new ForbiddenException('Workspace lifecycle denies operation');
  if (request.requiredRole === 'OWNER' && m.role !== 'OWNER')
    throw new ForbiddenException('OWNER required');
  const ownership =
    request.expectedOwnershipRevision ??
    (authority.mode === 'USER_DELEGATED'
      ? authority.ownershipRevision
      : undefined);
  if (
    (ownership !== undefined && ownership !== m.workspace.ownershipRevision) ||
    (authority.mode === 'USER_DELEGATED' &&
      authority.ownershipRevision !== undefined &&
      authority.ownershipRevision !== m.workspace.ownershipRevision)
  )
    throw new ForbiddenException('Ownership authority changed');
  return Object.freeze({
    mode: authority.mode,
    userId: authority.userId,
    authVersion: authority.authVersion,
    ...(authority.mode === 'SESSION_BOUND'
      ? { sessionId: authority.sessionId }
      : {}),
    workspaceId: m.workspaceId,
    membershipId: m.id,
    role: m.role,
    status: 'ACTIVE',
    membershipRevision: m.revision,
    workspaceLifecycle: lifecycle,
    ...(ownership === undefined
      ? {}
      : { ownershipRevision: m.workspace.ownershipRevision }),
  });
}

export function assertSameObservation(
  before: AuthorizationContext,
  after: AuthorizationContext,
): void {
  if (
    before.userId !== after.userId ||
    before.workspaceId !== after.workspaceId ||
    before.membershipId !== after.membershipId ||
    before.membershipRevision !== after.membershipRevision ||
    before.authVersion !== after.authVersion ||
    before.workspaceLifecycle !== after.workspaceLifecycle ||
    before.ownershipRevision !== after.ownershipRevision
  )
    throw new ForbiddenException('Authority changed during policy evaluation');
}
