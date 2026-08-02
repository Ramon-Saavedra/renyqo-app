import { describe, expect, it } from '@jest/globals';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('E2E database safety', () => {
  it('rejects renyqo_dev', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5433/renyqo_dev',
      ),
    ).toThrow('renyqo_e2e');
  });

  it('rejects staging_e2e', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5432/staging_e2e',
      ),
    ).toThrow('renyqo_e2e');
  });

  it('rejects production_e2e', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5432/production_e2e',
      ),
    ).toThrow('renyqo_e2e');
  });

  it('rejects names that only contain _e2e in the middle', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5434/renyqo_e2e_backup',
      ),
    ).toThrow('renyqo_e2e');
  });

  it('accepts exactly renyqo_e2e', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5434/renyqo_e2e',
      ),
    ).not.toThrow();
  });

  it('accepts RENYQO_E2E case-insensitively', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5434/RENYQO_E2E',
      ),
    ).not.toThrow();
  });
});
