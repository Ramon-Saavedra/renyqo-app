import {
  MEMBER_COLOR_IDS,
  isMemberColor,
  MEMBER_COLOR_TOKENS,
} from './member-color.catalog';
import { selectMemberColor } from './member-color.policy';
describe('Canonical member color assignment', () => {
  it('rejects arbitrary CSS and raw hex identifiers', () => {
    for (const value of [
      '#2563EB',
      'red',
      'url(javascript:alert(1))',
      '<style>',
      null,
    ])
      expect(isMemberColor(value)).toBe(false);
    expect(new Set(MEMBER_COLOR_IDS).size).toBe(MEMBER_COLOR_IDS.length);
  });
  it('prefers a free requested color and otherwise chooses unused in stable order', () => {
    expect(selectMemberColor(new Map(), 'BURGUNDY')).toBe('BURGUNDY');
    expect(selectMemberColor(new Map([['ROYAL_BLUE', 1]]), 'ROYAL_BLUE')).toBe(
      'BURGUNDY',
    );
  });
  it('uses least-used deterministic reuse after exhaustion without modifying current members', () => {
    const usage = new Map<(typeof MEMBER_COLOR_IDS)[number], number>(
      MEMBER_COLOR_IDS.map((id) => [id, 2] as const),
    );
    usage.set('MAGENTA', 1);
    expect(selectMemberColor(usage)).toBe('MAGENTA');
    usage.set('MAGENTA', 2);
    expect(selectMemberColor(usage)).toBe('ROYAL_BLUE');
    expect([...usage.values()].every((n) => n === 2)).toBe(true);
  });
  it('has reviewed contrast on the actual Renyqo theme surfaces', () => {
    const luminance = (hex: string) =>
      hex
        .slice(1)
        .match(/../g)!
        .map((v) => parseInt(v, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a: string, b: string) =>
      (Math.max(luminance(a), luminance(b)) + 0.05) /
      (Math.min(luminance(a), luminance(b)) + 0.05);
    for (const id of MEMBER_COLOR_IDS) {
      const token = MEMBER_COLOR_TOKENS[id];
      for (const bg of ['#edebe1', '#f1ead6', '#faf5e7', '#fffdf7'])
        expect(contrast(token.lightInk, bg)).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['#0c0c0e', '#151518', '#17171a'])
        expect(contrast(token.darkInk, bg)).toBeGreaterThanOrEqual(4.5);
      expect(
        Math.max(
          contrast(token.fill, '#000000'),
          contrast(token.fill, '#FFFFFF'),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
