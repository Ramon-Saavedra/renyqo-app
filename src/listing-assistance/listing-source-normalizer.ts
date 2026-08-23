export interface ListingSourceNormalization {
  livingArea: number | null;
  availableFrom: string | null;
  conflictingFields: ListingNormalizableField[];
  uncertainFields: ListingNormalizableField[];
}

export type ListingNormalizableField = 'livingArea' | 'availableFrom';

const SQUARE_METRE_PATTERN =
  /(?<![\w\u00C0-\u024F])(?:Wohnfl(?:ä|ae)che\s*[:=-]?\s*)?(\d+(?:[.,]\d+)?)\s*(?:m²|m2|qm|Quadratmeter)(?![\w\u00C0-\u024F])/gi;

const EXCLUDED_AREA_PATTERN =
  /(?:Grundstücks|Grundstuecks|Nutz|Balkon|Keller)\s*Fl(?:ä|ae)che\s*[:=-]?\s*\d+(?:[.,]\d+)?\s*(?:m²|m2|qm|Quadratmeter)|\d+(?:[.,]\d+)?\s*(?:m²|m2|qm|Quadratmeter)\s*(?:Grundstück|Grundstueck|Nutzfläche|Nutzflaeche|Balkon|Keller)/gi;

const IMMEDIATE_AVAILABILITY_PATTERN =
  /(?<![\w\u00C0-\u024F])(ab sofort|sofort\s+verfügbar|sofort|verfügbar\s+ab\s+heute|verfuegbar\s+ab\s+heute)(?![\w\u00C0-\u024F])/gi;

const GERMAN_DATE_PATTERN = /\b(\d{1,2})([.\-/])(\d{1,2})\2(\d{4})\b/g;

const COMPACT_DATE_PATTERN = /\b(\d{2})(\d{2})\.(\d{4})\b/g;

function toNumber(value: string): number {
  return Number.parseFloat(value.replace(',', '.'));
}

function isAmbiguousDayMonth(day: number, month: number): boolean {
  return day <= 12 && month <= 12 && day !== month;
}

function isValidDate(day: number, month: number, year: number): boolean {
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function hasAvailabilityDateContext(
  text: string,
  match: RegExpExecArray,
): boolean {
  if (text.trim() === match[0]) return true;
  const prefix = text.slice(Math.max(0, match.index - 48), match.index);
  return /(?:(?:verfügbar|verfuegbar|frei|bezugsfrei|einzug)\s+)?(?:ab|zum)\s*$/i.test(
    prefix,
  );
}

export function toBerlinIsoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const partMap = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== 'literal') {
      partMap.set(part.type, part.value);
    }
  }

  const year = partMap.get('year');
  const month = partMap.get('month');
  const day = partMap.get('day');

  if (!year || !month || !day) {
    throw new Error('Unable to format Berlin date');
  }

  return `${year}-${month}-${day}`;
}

function extractLivingArea(text: string): {
  value: number | null;
  conflicting: boolean;
} {
  const excludedRanges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  const excludedRegex = new RegExp(EXCLUDED_AREA_PATTERN.source, 'gi');
  while ((match = excludedRegex.exec(text)) !== null) {
    excludedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const candidates: Array<{ value: number; start: number; end: number }> = [];
  const areaRegex = new RegExp(SQUARE_METRE_PATTERN.source, 'gi');
  while ((match = areaRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const isExcluded = excludedRanges.some(
      (range) => start < range.end && end > range.start,
    );
    if (isExcluded) {
      continue;
    }

    const value = toNumber(match[1]);
    candidates.push({ value, start, end });
  }

  if (candidates.length === 0) {
    return { value: null, conflicting: false };
  }

  const firstValue = candidates[0]?.value;
  const allEqual = candidates.every(
    (candidate) => candidate.value === firstValue,
  );
  if (!allEqual || firstValue === undefined) {
    return { value: null, conflicting: true };
  }

  return { value: firstValue, conflicting: false };
}

function extractGermanDate(
  text: string,
): { value: string; ambiguous: boolean } | null {
  const candidates: Array<{ day: number; month: number; year: number }> = [];
  let match: RegExpExecArray | null;

  const dateRegex = new RegExp(GERMAN_DATE_PATTERN.source, 'g');
  while ((match = dateRegex.exec(text)) !== null) {
    if (!hasAvailabilityDateContext(text, match)) continue;
    const day = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[3], 10);
    const year = Number.parseInt(match[4], 10);
    candidates.push({ day, month, year });
  }

  const compactRegex = new RegExp(COMPACT_DATE_PATTERN.source, 'g');
  while ((match = compactRegex.exec(text)) !== null) {
    if (!hasAvailabilityDateContext(text, match)) continue;
    const day = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const year = Number.parseInt(match[3], 10);
    candidates.push({ day, month, year });
  }

  if (candidates.length === 0) {
    return null;
  }

  const first = candidates[0];
  const allEqual = candidates.every(
    (candidate) =>
      candidate.day === first?.day &&
      candidate.month === first?.month &&
      candidate.year === first?.year,
  );
  if (!allEqual || first === undefined) {
    return { value: '', ambiguous: true };
  }

  if (isAmbiguousDayMonth(first.day, first.month)) {
    return { value: '', ambiguous: true };
  }

  if (!isValidDate(first.day, first.month, first.year)) {
    return { value: '', ambiguous: true };
  }

  const iso = `${first.year}-${String(first.month).padStart(2, '0')}-${String(first.day).padStart(2, '0')}`;
  return { value: iso, ambiguous: false };
}

function extractImmediateAvailability(text: string, now: Date): string | null {
  const regex = new RegExp(IMMEDIATE_AVAILABILITY_PATTERN.source, 'gi');
  if (!regex.test(text)) {
    return null;
  }

  return toBerlinIsoDate(now);
}

export function normalizeListingSource(
  text: string,
  now: Date,
): ListingSourceNormalization {
  const livingAreaResult = extractLivingArea(text);
  const immediate = extractImmediateAvailability(text, now);
  const dateResult = extractGermanDate(text);

  const result: ListingSourceNormalization = {
    livingArea: livingAreaResult.value,
    availableFrom: null,
    conflictingFields: livingAreaResult.conflicting ? ['livingArea'] : [],
    uncertainFields: [],
  };

  if (immediate !== null && dateResult !== null) {
    if (!dateResult.ambiguous && immediate === dateResult.value) {
      result.availableFrom = immediate;
    } else {
      result.conflictingFields.push('availableFrom');
    }
  } else if (immediate !== null) {
    result.availableFrom = immediate;
  } else if (dateResult !== null) {
    if (dateResult.ambiguous) {
      result.uncertainFields.push('availableFrom');
    } else {
      result.availableFrom = dateResult.value;
    }
  }

  return result;
}
