import { isMemberColor, type MemberColor } from './member-color.catalog';
export type MemberActorSnapshot = Readonly<{
  snapshotVersion: 1;
  actorUserId: string;
  actorMembershipId: string;
  actorWorkspaceId: string;
  actorRoleAtTime: 'OWNER' | 'AGENT';
  actorDisplayNameAtTime: string;
  actorColorAtTime: MemberColor;
  capturedAt: string;
}>;
export function memberActorSnapshot(
  value: unknown,
): MemberActorSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    r.snapshotVersion !== 1 ||
    !isMemberColor(r.actorColorAtTime) ||
    (r.actorRoleAtTime !== 'OWNER' && r.actorRoleAtTime !== 'AGENT')
  )
    return null;
  for (const field of [
    'actorUserId',
    'actorMembershipId',
    'actorWorkspaceId',
    'actorDisplayNameAtTime',
    'capturedAt',
  ])
    if (typeof r[field] !== 'string') return null;
  const expected = [
    'snapshotVersion',
    'actorUserId',
    'actorMembershipId',
    'actorWorkspaceId',
    'actorRoleAtTime',
    'actorDisplayNameAtTime',
    'actorColorAtTime',
    'capturedAt',
  ];
  if (
    Object.keys(r).some((key) => !expected.includes(key)) ||
    !Number.isFinite(Date.parse(r.capturedAt as string))
  )
    return null;
  return Object.freeze({ ...r }) as MemberActorSnapshot;
}
export function historicalMemberActor(value: unknown) {
  const snapshot = memberActorSnapshot(value);
  return snapshot
    ? { state: 'CAPTURED' as const, snapshot }
    : { state: 'LEGACY_UNSNAPSHOTTED' as const, snapshot: null };
}
