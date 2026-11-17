import { readFileSync, readdirSync } from 'node:fs';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
jest.setTimeout(60000);
describe('Entitlement upgrade backfill', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start('20261116100000_workspace_plan_catalog'));
  afterAll(() => f.stop());
  it('backfills PERSONAL free and ORGANIZATION unassigned without inferring payment', async () => {
    const personal = f.command(await f.user(), 'PERSONAL'),
      organization = f.command(await f.user(), 'ORGANIZATION');
    for (const input of [personal, organization])
      await f.tx(async (tx) => {
        await installTenantContext(tx, input.workspaceId);
        await f.establishment.withinTransaction(tx, input);
      });
    // Hold an actual pre-cutover workspace creation while migration waits on root.
    const concurrent = f.command(await f.user(), 'PERSONAL');
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creation = f.tx(async (tx) => {
      await installTenantContext(tx, concurrent.workspaceId);
      await f.establishment.withinTransaction(tx, concurrent);
      ready();
      await gate;
    });
    await started;
    const migrator = await f.pool.connect();
    try {
      const pid = (
        await migrator.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const migration = migrator
        .query(
          readFileSync(
            'prisma/migrations/20261116100000_workspace_plan_catalog/migration.sql',
            'utf8',
          ),
        )
        .then(
          () => null,
          (error) => error as Error,
        );
      let blocked = false;
      const until = Date.now() + 2000;
      while (!blocked && Date.now() < until)
        blocked = (
          await f.pool.query<{ blocked: boolean }>(
            'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
            [pid],
          )
        ).rows[0].blocked;
      release();
      await creation;
      expect(await migration).toBeNull();
      expect(blocked).toBe(true);
    } finally {
      release();
      await creation;
      migrator.release();
    }
    for (const name of readdirSync('prisma/migrations')
      .sort()
      .filter(
        (name) =>
          name > '20261116100000_workspace_plan_catalog' &&
          name !== 'migration_lock.toml',
      ))
      await f.pool.query(
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    const rows = await f.prisma.workspacePlanAssignment.findMany({
      orderBy: { workspaceId: 'asc' },
    });
    expect(
      rows.find((r) => r.workspaceId === personal.workspaceId),
    ).toMatchObject({
      planVersionId: '45700000-0000-4000-8000-000000000001',
      revision: 1,
      source: 'BASELINE',
    });
    expect(
      rows.find((r) => r.workspaceId === organization.workspaceId),
    ).toMatchObject({ planVersionId: null, revision: 1, source: 'BASELINE' });
    expect(
      rows.find((r) => r.workspaceId === concurrent.workspaceId),
    ).toMatchObject({ planVersionId: '45700000-0000-4000-8000-000000000001' });
    expect(await f.prisma.workspacePlanChange.count()).toBe(3);
    const previous = await f.prisma.providerWorkspace.findUniqueOrThrow({
      where: { id: personal.workspaceId },
    });
    await f.tx(async (tx) => {
      await installTenantContext(tx, personal.workspaceId);
      await f.conversion.withinTransaction(tx, {
        workspaceId: personal.workspaceId,
        expectedRevision: previous.revision,
        legalName: 'Converted organization',
      });
    });
    expect(
      await f.prisma.workspacePlanAssignment.findUniqueOrThrow({
        where: { workspaceId: personal.workspaceId },
      }),
    ).toMatchObject({ planVersionId: null, source: 'INTERNAL', revision: 2 });
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { workspaceId: personal.workspaceId, releasedAt: null },
      }),
    ).toBe(1);
  });
});
