import type { AuthorizationContext } from '../domain/authorization.types';
import * as defaults from '../capabilities/provider-default-capabilities';
import { canReorderListings } from './listing-order.policy';
import type { ProviderCapability } from '../capabilities/provider-capability';

describe('Canonical workspace listing reorder authority', () => {
  const owner: AuthorizationContext = {
    mode: 'SESSION_BOUND',
    userId: 'user',
    authVersion: 1,
    workspaceId: 'workspace',
    membershipId: 'member',
    role: 'OWNER',
    status: 'ACTIVE',
    membershipRevision: 1,
    workspaceLifecycle: 'ACTIVE',
  };
  afterEach(() => jest.restoreAllMocks());
  it('allows an operational OWNER', () => {
    expect(canReorderListings(owner)).toBe(true);
  });
  it('does not turn normal AGENT operational capabilities into structural owner authority', () => {
    expect(canReorderListings({ ...owner, role: 'AGENT' })).toBe(false);
  });
  it.each(['SUSPENDED', 'REMOVED'])('denies %s designation', (status) => {
    expect(
      canReorderListings({ ...owner, status } as AuthorizationContext),
    ).toBe(false);
  });
  it.each(['CLOSING', 'CLOSED'] as const)(
    'denies %s workspaces',
    (workspaceLifecycle) => {
      expect(canReorderListings({ ...owner, workspaceLifecycle })).toBe(false);
    },
  );
  it('retains the canonical operation evaluator rather than bypassing invalid capability state', () => {
    jest
      .spyOn(defaults, 'providerDefaultCapabilities')
      .mockReturnValue(new Set(['UNKNOWN'] as unknown as ProviderCapability[]));
    expect(canReorderListings(owner)).toBe(false);
  });
});
