import {
  historicalMemberActor,
  memberActorSnapshot,
} from './actor-snapshot.contract';
describe('Historical member actor projection', () => {
  const snapshot = {
    snapshotVersion: 1,
    actorUserId: 'user',
    actorMembershipId: 'member',
    actorWorkspaceId: 'workspace',
    actorRoleAtTime: 'OWNER',
    actorDisplayNameAtTime: 'Original name',
    actorColorAtTime: 'ROYAL_BLUE',
    capturedAt: '2026-11-19T00:00:00Z',
  };
  it('preserves a closed immutable observation without mutable live joins', () => {
    const result = memberActorSnapshot(snapshot);
    expect(result).toEqual(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
    snapshot.actorDisplayNameAtTime = 'Later name';
    expect(result?.actorDisplayNameAtTime).toBe('Original name');
    snapshot.actorDisplayNameAtTime = 'Original name';
  });
  it('explicitly represents legacy absence and rejects security fields or invalid colors', () => {
    expect(historicalMemberActor(null)).toEqual({
      state: 'LEGACY_UNSNAPSHOTTED',
      snapshot: null,
    });
    expect(memberActorSnapshot({ ...snapshot, authVersion: 1 })).toBeNull();
    expect(
      memberActorSnapshot({ ...snapshot, actorColorAtTime: '#2563EB' }),
    ).toBeNull();
    expect(
      memberActorSnapshot({ ...snapshot, capturedAt: 'not-a-date' }),
    ).toBeNull();
  });
});
