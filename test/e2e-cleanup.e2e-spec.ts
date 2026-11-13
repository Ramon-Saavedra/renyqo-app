import type { PrismaClient } from '../src/generated/prisma/client';
import { clearE2EData } from './e2e-cleanup';

describe('Central E2E cleanup safety', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('starts each suite with canonical worker defaults before application boot', () => {
    expect(process.env).toMatchObject({
      NODE_ENV: 'test',
      DATABASE_URL: process.env['E2E_DATABASE_URL'],
      OUTBOX_DISPATCH_ENABLED: 'false',
      REALTIME_ENABLED: 'false',
      VIEWING_EXPIRY_ENABLED: 'false',
    });
  });

  it.each([
    { NODE_ENV: 'production' },
    { E2E_DATABASE_ALLOW_RESET: 'false' },
    { DATABASE_URL: 'postgresql://test@localhost/renyqo_dev' },
    {
      E2E_DATABASE_URL: 'postgresql://test@localhost/renyqo_dev',
      DATABASE_URL: 'postgresql://test@localhost/renyqo_dev',
    },
    { DATABASE_URL: 'postgresql://test@other-host/renyqo_e2e' },
  ])(
    'rejects unsafe configuration before accessing the database: %j',
    async (override) => {
      Object.assign(
        process.env,
        {
          NODE_ENV: 'test',
          E2E_DATABASE_ALLOW_RESET: 'true',
          DATABASE_URL: 'postgresql://test@localhost/renyqo_e2e',
          E2E_DATABASE_URL: 'postgresql://test@localhost/renyqo_e2e',
        },
        override,
      );
      const transaction = jest.fn();
      await expect(
        clearE2EData({ $transaction: transaction } as unknown as PrismaClient),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
