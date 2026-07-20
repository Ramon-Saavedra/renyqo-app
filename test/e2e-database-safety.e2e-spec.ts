import { describe, expect, it } from '@jest/globals';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('E2E database safety', () => {
  it('rejects renyqo_dev', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5433/renyqo_dev',
      ),
    ).toThrow('ending with "_e2e"');
  });

  it('accepts renyqo_e2e', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5434/renyqo_e2e',
      ),
    ).not.toThrow();
  });

  it('rejects names that only contain _e2e in the middle', () => {
    expect(() =>
      assertSafeE2EDatabaseUrl(
        'postgresql://renyqo:renyqo_dev@localhost:5434/renyqo_e2e_backup',
      ),
    ).toThrow('ending with "_e2e"');
  });
});
