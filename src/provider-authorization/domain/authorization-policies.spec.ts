import { randomUUID } from 'node:crypto';
import type { SafeUser } from '../../users/types/safe-user.type';
import type { Request } from 'express';
import {
  captureHumanAuthority,
  delegateContext,
  positiveEpoch,
  sessionAuthorityFromRequest,
} from './authority-reference';
import {
  assertSameObservation,
  captureRequirement,
  workspaceContext,
} from './workspace-authority.policy';
import type {
  AuthorizationRequirement,
  SessionAuthority,
} from './authorization.types';
import { assertSameCommand, bindCommand } from './command-replay.policy';

describe('Workspace authorization contracts', () => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const membershipId = randomUUID();
  const authority: SessionAuthority = {
    mode: 'SESSION_BOUND',
    userId,
    authVersion: 1,
    sessionId: 'server-sid',
  };
  const request: AuthorizationRequirement = {
    workspaceId,
    purpose: 'OPERATIONAL',
    action: 'test.read',
    resourceIds: [],
  };
  const facts = {
    id: membershipId,
    workspaceId,
    userId,
    role: 'AGENT' as const,
    status: 'ACTIVE' as const,
    revision: 1,
    workspace: { lifecycleStatus: 'ACTIVE' as const, ownershipRevision: 1 },
  };

  it('binds a command to the authorized actor, tenant, action and original input', () => {
    const context = workspaceContext(authority, request, facts);
    const binding = bindCommand(context, request, 'command', 'fingerprint');
    expect(() => assertSameCommand(binding, binding)).not.toThrow();
    for (const change of [
      { userId: randomUUID() },
      { workspaceId: randomUUID() },
      { action: 'other' },
      { inputFingerprint: 'changed' },
    ])
      expect(() =>
        assertSameCommand(binding, { ...binding, ...change }),
      ).toThrow('Command input changed');
  });

  it.each([0, -1, 1.5, Number.NaN, 2147483648])(
    'rejects invalid epoch %s',
    (value) => {
      expect(positiveEpoch(value)).toBe(false);
    },
  );
  it('copies and freezes authority/selection so caller mutation cannot broaden a pending request', () => {
    const resources = ['a'];
    const selection = captureRequirement({
      ...request,
      resourceIds: resources,
    });
    resources.push('b');
    expect(selection.resourceIds).toEqual(['a']);
    expect(Object.isFrozen(selection.resourceIds)).toBe(true);
    const context = workspaceContext(authority, request, facts);
    const delegated = delegateContext(context, selection);
    expect(Object.isFrozen(delegated.scope)).toBe(true);
    expect(delegated).not.toHaveProperty('sessionId');
    expect(captureHumanAuthority(authority)).not.toBe(authority);
  });
  it('creates session reference solely from an already authenticated server request', () => {
    const user = {
      id: userId,
      name: 'User',
      email: 'user@test',
      role: 'APPLICANT',
      providerType: null,
      companyName: null,
      emailVerified: true,
      status: 'ACTIVE',
      acceptedTermsAt: new Date(),
      acceptedPrivacyAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      authVersion: 1,
    } as SafeUser;
    const req = {
      isAuthenticated: () => true,
      user,
      sessionID: 'real-server-sid',
    } as unknown as Pick<Request, 'isAuthenticated' | 'user' | 'sessionID'>;
    expect(sessionAuthorityFromRequest(req)).toEqual({
      ...authority,
      sessionId: 'real-server-sid',
    });
    expect(() =>
      sessionAuthorityFromRequest({
        ...req,
        isAuthenticated: () => false,
      } as typeof req),
    ).toThrow();
    expect(() =>
      sessionAuthorityFromRequest({
        ...req,
        user: { ...user, authVersion: undefined },
      }),
    ).toThrow();
  });
  it('does not accept forged or missing purpose/role requirements', () => {
    expect(() =>
      captureRequirement({
        ...request,
        purpose: 'UNKNOWN',
      } as unknown as AuthorizationRequirement),
    ).toThrow();
    expect(() =>
      captureRequirement({
        ...request,
        requiredRole: 'ADMIN',
      } as unknown as AuthorizationRequirement),
    ).toThrow();
  });
  it('detects changed authority after read policy evaluation', () => {
    const context = workspaceContext(authority, request, facts);
    expect(() =>
      assertSameObservation(context, { ...context, membershipRevision: 2 }),
    ).toThrow();
    expect(() =>
      assertSameObservation(context, {
        ...context,
        workspaceLifecycle: 'CLOSING',
      }),
    ).toThrow();
  });
});
