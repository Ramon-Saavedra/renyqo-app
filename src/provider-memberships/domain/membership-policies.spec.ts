import {
  assertMembershipTransition,
  consumesSeat,
} from './membership-lifecycle.policy';
import { ownershipTransition } from './ownership-transition.policy';

describe('Membership lifecycle policies', () => {
  it.each([
    ['ACTIVE', 'SUSPENDED'],
    ['SUSPENDED', 'ACTIVE'],
    ['ACTIVE', 'REMOVED'],
    ['SUSPENDED', 'REMOVED'],
    ['REMOVED', 'ACTIVE'],
    ['ACTIVE', 'ACTIVE'],
  ] as const)('allows AGENT %s to %s', (from, to) => {
    expect(() => assertMembershipTransition('AGENT', from, to)).not.toThrow();
  });
  it('rejects removed suspension and OWNER removal', () => {
    expect(() =>
      assertMembershipTransition('AGENT', 'REMOVED', 'SUSPENDED'),
    ).toThrow();
    expect(() =>
      assertMembershipTransition('OWNER', 'ACTIVE', 'REMOVED'),
    ).toThrow();
    expect(() =>
      assertMembershipTransition('OWNER', 'SUSPENDED', 'REMOVED'),
    ).toThrow();
  });
  it('retains the seat while suspended and releases it only on removal', () => {
    expect(
      ['ACTIVE', 'SUSPENDED', 'REMOVED'].map((s) =>
        consumesSeat(s as 'ACTIVE' | 'SUSPENDED' | 'REMOVED'),
      ),
    ).toEqual([true, true, false]);
  });
  it.each(['DEMOTE_TO_AGENT', 'REMOVE_MEMBERSHIP'] as const)(
    'defines %s structural outcome without capability authority',
    (outcome) => {
      const plan = ownershipTransition(outcome);
      expect(plan).toEqual({
        formerOwner: {
          role: 'AGENT',
          status: outcome === 'DEMOTE_TO_AGENT' ? 'ACTIVE' : 'REMOVED',
        },
        target: { role: 'OWNER', status: 'ACTIVE' },
      });
    },
  );
});
