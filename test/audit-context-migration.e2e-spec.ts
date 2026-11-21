import { readFileSync } from 'node:fs';
import { auditEvent } from './audit.fixture';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { auditContextMigrations } from './audit-migrations.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { AuditWriter } from '../src/audit/persistence/audit-writer';
import { clearE2EData, assertE2EDatabaseEmpty } from './e2e-cleanup';
jest.setTimeout(60000);
describe('Audit Slice 2 additive populated upgrade', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start(auditContextMigrations[0]));
  afterAll(() => f.stop());
  it('preserves a Slice 1 event without inventing identity snapshots and keeps test reset usable', async () => {
    const w = f.command(await f.user(), 'ORGANIZATION');
    const event = auditEvent(w.workspaceId);
    await f.tx(async (tx) => {
      await installTenantContext(tx, w.workspaceId);
      await f.establishment.withinTransaction(tx, w);
      await new AuditWriter().append(tx, event);
    });
    const before = (
      await f.pool.query('SELECT * FROM audit_events WHERE id=$1', [event.id])
    ).rows[0] as Record<string, unknown>;
    for (const migration of auditContextMigrations)
      await f.pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      );
    const after = (
      await f.pool.query('SELECT * FROM audit_events WHERE id=$1', [event.id])
    ).rows[0] as Record<string, unknown>;
    expect(after).toEqual({ ...before, actor_identity_id: null });
    expect(await f.prisma.auditActorIdentity.count()).toBe(0);
    expect(await f.prisma.auditExecutionContext.count()).toBe(0);
    await clearE2EData(f.prisma);
    await assertE2EDatabaseEmpty(f.prisma);
  });
});
