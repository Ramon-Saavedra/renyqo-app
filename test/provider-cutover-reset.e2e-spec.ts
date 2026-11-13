import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceFixture } from './provider-workspaces.fixture';

jest.setTimeout(30000);
describe('Bounded disposable provider-data cutover reset', () => {
  const f = new WorkspaceFixture();
  let userId: string, listingId: string;
  beforeAll(async () => {
    await f.start();
    userId = await f.user();
    await f.establish(f.command(userId));
    await f.prisma.applicantProfile.create({
      data: { applicantId: userId, introduction: 'Retained global profile' },
    });
    listingId = randomUUID();
    await f.pool.query(
      `INSERT INTO listings(id,provider_id,display_order,updated_at) VALUES($1,$2,1,clock_timestamp())`,
      [listingId, userId],
    );
  });
  afterAll(() => f.stop());
  function reset(apply: boolean) {
    return execFileSync(
      process.execPath,
      ['scripts/reset-disposable-provider-data.cjs'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PROVIDER_RESET_DATABASE_URL: process.env['E2E_DATABASE_URL'],
          PROVIDER_RESET_DATABASE_NAME: decodeURIComponent(
            new URL(process.env['E2E_DATABASE_URL']!).pathname.slice(1),
          ),
          PROVIDER_RESET_SCHEMA: f.schema,
          PROVIDER_RESET_APPLY: String(apply),
          ALLOW_DISPOSABLE_PROVIDER_RESET: '4.5.5',
          PROVIDER_WRITES_QUIESCED: 'true',
        },
      },
    );
  }
  it('defaults to inventory and leaves disposable Listing records intact', async () => {
    const result = JSON.parse(reset(false)) as {
      applied: boolean;
      counts: unknown[];
    };
    expect(result.applied).toBe(false);
    expect(result.counts).toHaveLength(27);
    expect((await f.pool.query('SELECT id FROM listings')).rows).toEqual([
      { id: listingId },
    ]);
  });
  it('resets only the reviewed provider FK graph while preserving global identity/profile and workspace history', async () => {
    const result = JSON.parse(reset(true)) as { applied: boolean };
    expect(result.applied).toBe(true);
    expect((await f.pool.query('SELECT id FROM listings')).rows).toEqual([]);
    expect(
      await f.prisma.user.findUnique({ where: { id: userId } }),
    ).not.toBeNull();
    expect(
      await f.prisma.applicantProfile.findUnique({
        where: { applicantId: userId },
      }),
    ).not.toBeNull();
    expect(await f.prisma.providerWorkspace.count()).toBe(1);
    expect(await f.prisma.personalWorkspaceAllocation.count()).toBe(1);
  });
  it('refuses this reset after the canonical workspace Listing cutover', async () => {
    await f.pool.query(
      readFileSync(
        'prisma/migrations/20261108120000_workspace_tenant_rls/migration.sql',
        'utf8',
      ),
    );
    await f.pool.query(
      readFileSync(
        'prisma/migrations/20261108150000_listing_workspace_assignment/migration.sql',
        'utf8',
      ),
    );
    expect(() => reset(true)).toThrow();
  });
});
