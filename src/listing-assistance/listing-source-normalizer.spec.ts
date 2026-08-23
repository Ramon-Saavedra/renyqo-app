import { describe, expect, it } from '@jest/globals';
import { normalizeListingSource } from './listing-source-normalizer';

const fixedNow = new Date('2026-08-22T12:00:00.000Z');

describe('normalizeListingSource', () => {
  describe('livingArea', () => {
    it.each([
      ['100 qm', 100],
      ['100 m²', 100],
      ['100 m2', 100],
      ['100 Quadratmeter', 100],
      ['Wohnfläche 100 qm', 100],
      ['Wohnfläche: 100 qm', 100],
      ['Wohnflaeche 75,5 m2', 75.5],
      ['100 m² Wohnfläche', 100],
    ])('extracts %s as %s', (text, expected) => {
      const result = normalizeListingSource(text, fixedNow);
      expect(result.livingArea).toBe(expected);
    });

    it.each([
      'Grundstücksfläche 500 qm',
      'Nutzfläche 120 m²',
      'Balkonfläche 10 qm',
      'Kellerfläche 8 m2',
      'Nutzfläche: 120 m²',
      'Keine Angabe zur Wohnfläche',
    ])('does not extract non-living area from %s', (text) => {
      const result = normalizeListingSource(text, fixedNow);
      expect(result.livingArea).toBeNull();
    });

    it('ignores non-living area and extracts living area', () => {
      const result = normalizeListingSource(
        'Wohnfläche 80 qm. Grundstücksfläche 500 qm.',
        fixedNow,
      );
      expect(result.livingArea).toBe(80);
    });

    it('returns null when multiple living area values conflict', () => {
      const result = normalizeListingSource(
        '80 qm Wohnfläche und 90 qm Wohnfläche',
        fixedNow,
      );
      expect(result.livingArea).toBeNull();
    });
  });

  describe('availableFrom immediate availability', () => {
    it.each([
      'ab sofort',
      'sofort',
      'sofort verfügbar',
      'verfügbar ab heute',
      'Sofort verfuegbar',
    ])('maps %s to current Berlin date', (text) => {
      const result = normalizeListingSource(text, fixedNow);
      expect(result.availableFrom).toBe('2026-08-22');
      expect(result.uncertainFields).toEqual([]);
    });
  });

  describe('availableFrom numeric dates', () => {
    it.each([
      ['13.10.2026', '2026-10-13'],
      ['13-10-2026', '2026-10-13'],
      ['13/10/2026', '2026-10-13'],
      ['1310.2026', '2026-10-13'],
      ['1.1.2027', '2027-01-01'],
    ])('parses %s as %s', (text, expected) => {
      const result = normalizeListingSource(text, fixedNow);
      expect(result.availableFrom).toBe(expected);
      expect(result.uncertainFields).toEqual([]);
    });

    it.each(['10/11/2026', '10-11-2026', '10.11.2026', '32.10.2026'])(
      'marks ambiguous or invalid date %s as uncertain',
      (text) => {
        const result = normalizeListingSource(text, fixedNow);
        expect(result.availableFrom).toBeNull();
        expect(result.uncertainFields).toContain('availableFrom');
      },
    );

    it('keeps an unambiguous date even when it is in the past', () => {
      const result = normalizeListingSource('13.10.2025', fixedNow);
      expect(result.availableFrom).toBe('2025-10-13');
      expect(result.uncertainFields).toEqual([]);
    });

    it('marks ambiguous when immediate and numeric date are both present', () => {
      const result = normalizeListingSource(
        'ab sofort, alternativ verfügbar ab 13.10.2026',
        fixedNow,
      );
      expect(result.availableFrom).toBeNull();
      expect(result.conflictingFields).toContain('availableFrom');
    });

    it('does not interpret an unrelated viewing date as availability', () => {
      const result = normalizeListingSource(
        'Besichtigung am 13.10.2026',
        fixedNow,
      );
      expect(result.availableFrom).toBeNull();
      expect(result.uncertainFields).toEqual([]);
    });

    it('does not match immediate availability inside another word', () => {
      const result = normalizeListingSource(
        'Sofortüberweisung wird nicht akzeptiert',
        fixedNow,
      );
      expect(result.availableFrom).toBeNull();
    });
  });

  describe('short complementary inputs', () => {
    it.each(['ab sofort', 'Haustiere erlaubt'])(
      'handles %s without error',
      (text) => {
        const result = normalizeListingSource(text, fixedNow);
        expect(result).toBeDefined();
      },
    );
  });
});
