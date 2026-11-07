import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { isSafeUser } from '../../users/types/safe-user.type';
import type {
  ActionScope,
  AuthorizationContext,
  AuthorizationRequirement,
  DelegatedAuthority,
  HumanAuthority,
  SessionAuthority,
} from './authorization.types';

export function positiveEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

export function isAuthorityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function freezeScope(scope: ActionScope): ActionScope {
  if (
    !scope ||
    typeof scope.action !== 'string' ||
    !scope.action.trim() ||
    !Array.isArray(scope.resourceIds) ||
    scope.resourceIds.some((id) => typeof id !== 'string' || !id)
  )
    throw new ForbiddenException('Invalid action scope');
  return Object.freeze({
    action: scope.action,
    resourceIds: Object.freeze([...new Set(scope.resourceIds)].sort()),
  });
}

export function captureHumanAuthority(
  authority: HumanAuthority,
): HumanAuthority {
  if (
    !authority ||
    !['SESSION_BOUND', 'USER_DELEGATED'].includes(authority.mode) ||
    !isAuthorityId(authority.userId) ||
    !positiveEpoch(authority.authVersion)
  )
    throw new UnauthorizedException('Human authority required');
  if (authority.mode === 'SESSION_BOUND') {
    if (typeof authority.sessionId !== 'string' || !authority.sessionId)
      throw new UnauthorizedException();
    return Object.freeze({
      mode: authority.mode,
      userId: authority.userId.toLowerCase(),
      authVersion: authority.authVersion,
      sessionId: authority.sessionId,
    });
  }
  if (
    !isAuthorityId(authority.workspaceId) ||
    !isAuthorityId(authority.membershipId) ||
    !positiveEpoch(authority.membershipRevision) ||
    (authority.ownershipRevision !== undefined &&
      !positiveEpoch(authority.ownershipRevision))
  )
    throw new ForbiddenException('Invalid delegation');
  return Object.freeze({
    mode: authority.mode,
    userId: authority.userId.toLowerCase(),
    authVersion: authority.authVersion,
    workspaceId: authority.workspaceId.toLowerCase(),
    membershipId: authority.membershipId.toLowerCase(),
    membershipRevision: authority.membershipRevision,
    ...(authority.ownershipRevision === undefined
      ? {}
      : { ownershipRevision: authority.ownershipRevision }),
    scope: freezeScope(authority.scope),
  });
}

// Invoke after existing Passport authentication. No request body/header may
// supply the principal or choose a different durable grant.
export function sessionAuthorityFromRequest(
  req: Pick<Request, 'isAuthenticated' | 'user' | 'sessionID'>,
): SessionAuthority {
  if (
    !req.isAuthenticated() ||
    !isSafeUser(req.user) ||
    req.user.status !== 'ACTIVE' ||
    req.user.authVersion === undefined
  )
    throw new UnauthorizedException();
  return captureHumanAuthority({
    mode: 'SESSION_BOUND',
    userId: req.user.id,
    authVersion: req.user.authVersion,
    sessionId: req.sessionID,
  }) as SessionAuthority;
}

export function delegateContext(
  context: AuthorizationContext,
  scope: ActionScope,
): DelegatedAuthority {
  return captureHumanAuthority({
    mode: 'USER_DELEGATED',
    userId: context.userId,
    authVersion: context.authVersion,
    workspaceId: context.workspaceId,
    membershipId: context.membershipId,
    membershipRevision: context.membershipRevision,
    ...(context.ownershipRevision === undefined
      ? {}
      : { ownershipRevision: context.ownershipRevision }),
    scope,
  }) as DelegatedAuthority;
}

export function assertDelegatedScope(
  authority: HumanAuthority,
  request: AuthorizationRequirement,
): void {
  if (authority.mode !== 'USER_DELEGATED') return;
  if (
    authority.workspaceId !== request.workspaceId ||
    authority.scope.action !== request.action ||
    request.resourceIds.some(
      (id) => !authority.scope.resourceIds.includes(id),
    ) ||
    (authority.scope.resourceIds.length > 0 && request.resourceIds.length === 0)
  )
    throw new ForbiddenException('Outside delegated scope');
}
