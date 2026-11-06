import type { ProviderWorkspace } from '../../generated/prisma/client';
import {
  organizationLegalName,
  requireExpectedRevision,
  requireWorkspaceRevision,
  requireWorkspaceState,
  workspaceDisplayName,
} from './workspace-policy';

describe('Workspace value boundaries', () => {
  it('normalizes presentation/legal names without manufacturing legal identity', () => {
    expect(workspaceDisplayName('  Agency  ')).toBe('Agency');
    expect(organizationLegalName('  Agency GmbH  ')).toBe('Agency GmbH');
    expect(organizationLegalName(null)).toBeNull();
    expect(() => workspaceDisplayName('   ')).toThrow();
    expect(() => workspaceDisplayName('a'.repeat(161))).toThrow();
    expect(() => organizationLegalName('   ')).toThrow();
    expect(() => organizationLegalName('a'.repeat(241))).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected revision %s before retry/state handling',
    (revision) => {
      expect(() => requireExpectedRevision(revision)).toThrow();
    },
  );

  it('rejects stale state without conflating lifecycle with billing/security', () => {
    const workspace = {
      revision: 3,
      lifecycleStatus: 'CLOSED',
    } as ProviderWorkspace;
    expect(() => requireWorkspaceRevision(workspace, 2)).toThrow('revision');
    expect(() => requireWorkspaceRevision(workspace, 3)).not.toThrow();
    expect(() => requireWorkspaceState(workspace, 'ACTIVE')).toThrow('ACTIVE');
  });
});
