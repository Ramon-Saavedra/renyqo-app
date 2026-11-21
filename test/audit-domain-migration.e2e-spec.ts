import { readFileSync } from 'node:fs';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { auditDomainMigrations } from './audit-migrations.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { AuditWriter } from '../src/audit/persistence/audit-writer';
import { auditEvent } from './audit.fixture';
jest.setTimeout(60000);
describe('Slice 3 populated forward migration', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start(auditDomainMigrations[0]));
  afterAll(() => f.stop());
  it('preserves prior ledger rows and does not invent historical domain evidence', async () => {
    const w = f.command(await f.user(), 'ORGANIZATION'),
      event = auditEvent(w.workspaceId);
    await f.tx(async (tx) => {
      await installTenantContext(tx, w.workspaceId);
      await f.establishment.withinTransaction(tx, w);
      await new AuditWriter().append(tx, event);
    });
    const before = await f.prisma.auditEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    for (const name of auditDomainMigrations)
      await f.pool.query(
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    expect(
      await f.prisma.auditEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toEqual(before);
    expect(await f.prisma.auditEvent.count()).toBe(1);
    expect(await f.prisma.auditExecutionContext.count()).toBe(0);
  });
});
