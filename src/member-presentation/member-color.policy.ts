import {
  MEMBER_COLOR_IDS,
  isMemberColor,
  type MemberColor,
} from './member-color.catalog';
export function selectMemberColor(
  usage: ReadonlyMap<MemberColor, number>,
  requested?: MemberColor | null,
): MemberColor {
  if (requested && !isMemberColor(requested))
    throw new Error('Invalid member color');
  if (requested && !(usage.get(requested) ?? 0)) return requested;
  return MEMBER_COLOR_IDS.reduce(
    (best, id) => ((usage.get(id) ?? 0) < (usage.get(best) ?? 0) ? id : best),
    MEMBER_COLOR_IDS[0],
  );
}
