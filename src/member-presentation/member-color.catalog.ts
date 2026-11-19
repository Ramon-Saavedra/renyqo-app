// Stable order is also the deterministic admission/backfill tie-breaker.
export const MEMBER_COLOR_IDS = Object.freeze([
  'ROYAL_BLUE',
  'BURGUNDY',
  'DARK_PURPLE',
  'STRONG_VIOLET',
  'PETROL_BLUE',
  'STRONG_CYAN',
  'TURQUOISE',
  'EMERALD_GREEN',
  'STRONG_GREEN',
  'LIME_GREEN',
  'INDUSTRIAL_YELLOW',
  'STRONG_ORANGE',
  'STRONG_RED',
  'FUCHSIA',
  'MAGENTA',
  'COPPER',
  'INDIGO',
] as const);
export type MemberColor = (typeof MEMBER_COLOR_IDS)[number];
export function isMemberColor(value: unknown): value is MemberColor {
  return (
    typeof value === 'string' && MEMBER_COLOR_IDS.some((id) => id === value)
  );
}

// Reviewed candidate rendering contract, not client-provided styles. A strong
// fill uses the higher-contrast black/white label; ink variants suit theme surfaces.
export const MEMBER_COLOR_TOKENS: Readonly<
  Record<
    MemberColor,
    Readonly<{
      fill: string;
      lightInk: string;
      darkInk: string;
    }>
  >
> = Object.freeze({
  ROYAL_BLUE: { fill: '#2455E6', lightInk: '#1D4ED8', darkInk: '#5580FF' },
  BURGUNDY: { fill: '#98002E', lightInk: '#98002E', darkInk: '#FF4277' },
  DARK_PURPLE: { fill: '#6200A3', lightInk: '#6200A3', darkInk: '#CA65FF' },
  STRONG_VIOLET: { fill: '#7C2BEB', lightInk: '#6D28D9', darkInk: '#B875FF' },
  PETROL_BLUE: { fill: '#006071', lightInk: '#005666', darkInk: '#00C3DB' },
  STRONG_CYAN: { fill: '#00B8D9', lightInk: '#00637A', darkInk: '#00D5F5' },
  TURQUOISE: { fill: '#00A68A', lightInk: '#006858', darkInk: '#00D7B1' },
  EMERALD_GREEN: { fill: '#008A50', lightInk: '#006B3D', darkInk: '#00D47B' },
  STRONG_GREEN: { fill: '#268A10', lightInk: '#22690D', darkInk: '#54DA28' },
  LIME_GREEN: { fill: '#A0C900', lightInk: '#4E6300', darkInk: '#B6E600' },
  INDUSTRIAL_YELLOW: {
    fill: '#FFCC00',
    lightInk: '#725600',
    darkInk: '#FFCC00',
  },
  STRONG_ORANGE: { fill: '#F26600', lightInk: '#9A3D00', darkInk: '#FF8B24' },
  STRONG_RED: { fill: '#D92323', lightInk: '#B91C1C', darkInk: '#FF5353' },
  FUCHSIA: { fill: '#B800BC', lightInk: '#9B009F', darkInk: '#EF42F4' },
  MAGENTA: { fill: '#CF0069', lightInk: '#AD0058', darkInk: '#FF428F' },
  COPPER: { fill: '#AD551A', lightInk: '#854014', darkInk: '#EF934B' },
  INDIGO: { fill: '#4030B8', lightInk: '#4030B8', darkInk: '#8A7EFF' },
});
