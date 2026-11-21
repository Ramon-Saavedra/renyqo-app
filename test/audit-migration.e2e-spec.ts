import { readFileSync } from 'node:fs';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { auditMigrations } from './audit-migrations.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { clearE2EData, assertE2EDatabaseEmpty } from './e2e-cleanup';
jest.setTimeout(60000);

describe('Additive audit migration on populated current schema', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start(auditMigrations[0]));
  afterAll(() => f.stop());
  it('preserves existing tenant/member identity and starts with an empty ledger', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await f.establishment.withinTransaction(tx, input);
    });
    const before = await f.prisma.providerWorkspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      include: { memberships: true },
    });
    for (const migration of auditMigrations)
      await f.pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      );
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: input.workspaceId },
        include: { memberships: true },
      }),
    ).toEqual(before);
    expect(await f.prisma.auditEvent.count()).toBe(0);
    const result = await f.pool.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='audit_events'::regclass`,
    );
    expect(result.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    // The trusted disposable-schema reset stays usable without disabling any
    // trigger or weakening the ordinary runtime's TRUNCATE denial.
    await clearE2EData(f.prisma);
    await assertE2EDatabaseEmpty(f.prisma);
  });
});
