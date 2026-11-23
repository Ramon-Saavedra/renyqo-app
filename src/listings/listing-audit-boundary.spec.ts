import type { Prisma } from '../generated/prisma/client';
import { unitContext } from '../../test/unit-workspace-authority';
import { withListingLifecycleAudit } from './listing-audit-boundary';
import { listingLifecycleAudit } from './listing-lifecycle-audit';

jest.mock('./listing-lifecycle-audit', () => ({
  listingLifecycleAudit: jest.fn(),
}));
describe('Listing-only Audit transaction boundary', () => {
  it('never accesses Application models and fences completion after append', async () => {
    const trace: string[] = [];
    const row = { id: 'listing', workspaceId: 'workspace' };
    const tx = new Proxy(
      {
        listing: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
        $executeRaw: jest.fn(() => {
          trace.push('fence');
          return Promise.resolve(1);
        }),
      },
      {
        get(target, property) {
          if (property === 'application' || property === 'applicationActivity')
            throw new Error('Listing-only Audit accessed Applications');
          return Reflect.get(target, property) as unknown;
        },
      },
    ) as unknown as Prisma.TransactionClient;
    jest.mocked(listingLifecycleAudit).mockImplementation(() => {
      trace.push('append');
      return Promise.resolve();
    });
    expect(
      await withListingLifecycleAudit(
        tx,
        { kind: 'MEMBER', context: unitContext('owner') },
        'command',
        'listing',
        () => {
          trace.push('mutation');
          return Promise.resolve(42);
        },
      ),
    ).toBe(42);
    expect(trace).toEqual(['mutation', 'append', 'fence']);
  });
});
