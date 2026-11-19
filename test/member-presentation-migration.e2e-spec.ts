import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import {
  seedEntitlementTestCatalog,
  assignEntitlementTestPlan,
} from './entitlement-test-catalog';
import { MEMBER_COLOR_IDS } from '../src/member-presentation/member-color.catalog';
jest.setTimeout(60000);
describe('Canonical color upgrade and explicit legacy evidence', () => {
  const f = new WorkspaceFixture(),
    unknown = new WorkspaceFixture();
  beforeAll(async () => {
    await f.start('20261117100000_invitation_identity_schema');
    await unknown.start('20261119100000_member_color_catalog');
  });
  afterAll(async () => {
    try {
      await f.stop();
    } finally {
      await unknown.stop();
    }
  });
  it('normalizes deterministically, preserves all identities/epochs and does not fabricate historical snapshots', async () => {
    const w = f.command(await f.user(), 'ORGANIZATION');
    await seedEntitlementTestCatalog(f.pool);
    await f.tx(async (tx) => {
      await installTenantContext(tx, w.workspaceId);
      await f.establishment.withinTransaction(tx, w);
      await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${w.workspaceId}::uuid,1)`;
      await assignEntitlementTestPlan(tx, w.workspaceId, w.membershipId);
    });
    for (let n = 0; n < 20; n++) {
      const userId = await f.user();
      await f.tx(async (tx) => {
        await installTenantContext(tx, w.workspaceId);
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${w.workspaceId}::uuid,1)`;
        const m = await tx.workspaceMembership.create({
          data: {
            id: randomUUID(),
            workspaceId: w.workspaceId,
            userId,
            role: 'AGENT',
            displayColor: n % 2 ? '#7C3AED' : '#2563EB',
          },
        });
        if (n === 0 || n === 1)
          await tx.workspaceMembership.update({
            where: { id: m.id },
            data: { status: n === 0 ? 'SUSPENDED' : 'REMOVED' },
          });
      });
    }
    const before = await f.prisma.workspaceMembership.findMany({
      where: { workspaceId: w.workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const script = readFileSync(
      'prisma/migrations/20261119100000_member_color_catalog/migration.sql',
      'utf8',
    );
    // Apply the accepted invitation foundation first; seeded members are real
    // historical allocations, not new admissions bypassing the current proof.
    for (const name of readdirSync('prisma/migrations')
      .sort()
      .filter(
        (n) =>
          n !== 'migration_lock.toml' &&
          n >= '20261117100000_invitation_identity_schema' &&
          n < '20261119100000_member_color_catalog',
      ))
      await f.pool.query(
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    await f.pool.query(script);
    for (const name of readdirSync('prisma/migrations')
      .sort()
      .filter(
        (n) =>
          n !== 'migration_lock.toml' &&
          n > '20261119100000_member_color_catalog',
      ))
      await f.pool.query(
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
    const after = await f.prisma.workspaceMembership.findMany({
      where: { workspaceId: w.workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(after.map((m) => ({ ...m, displayColor: undefined }))).toEqual(
      before.map((m) => ({ ...m, displayColor: undefined })),
    );
    expect(
      after.filter((m) => m.status !== 'REMOVED').map((m) => m.displayColor),
    ).toEqual(
      before
        .filter((m) => m.status !== 'REMOVED')
        .map((_, i) => MEMBER_COLOR_IDS[i % MEMBER_COLOR_IDS.length]),
    );
    expect(after.find((m) => m.status === 'REMOVED')?.displayColor).toBe(
      'STRONG_VIOLET',
    );
    expect(
      (
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: w.workspaceId },
        })
      ).ownershipRevision,
    ).toBe(1);
    expect(
      (await f.prisma.workspacePlanChange.findMany()).every(
        (r) => r.actorSnapshot === null,
      ),
    ).toBe(true);
    expect(
      (
        await f.pool.query(
          `SELECT tgenabled FROM pg_trigger WHERE tgname='membership_identity_guard' AND tgrelid='workspace_memberships'::regclass`,
        )
      ).rows,
    ).toEqual([{ tgenabled: 'O' }]);
  });
  it('aborts on unknown legacy values before any identity/color or trigger change', async () => {
    const input = unknown.command(await unknown.user(), 'ORGANIZATION');
    await unknown.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await unknown.workspaces.create(tx, {
        id: input.workspaceId,
        kind: 'ORGANIZATION',
        displayName: 'Historical unknown color',
      });
      await tx.workspaceMembership.create({
        data: {
          id: input.membershipId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          role: 'OWNER',
          displayColor: '#ABCDEF',
        },
      });
      await unknown.profiles.create(
        tx,
        input.workspaceId,
        'Historical organization',
      );
    });
    const c = await unknown.pool.connect();
    try {
      await expect(
        c.query(
          readFileSync(
            'prisma/migrations/20261119100000_member_color_catalog/migration.sql',
            'utf8',
          ),
        ),
      ).rejects.toThrow('Unknown legacy membership color');
      await c.query('ROLLBACK');
      expect(
        (
          await unknown.prisma.workspaceMembership.findUniqueOrThrow({
            where: { id: input.membershipId },
          })
        ).displayColor,
      ).toBe('#ABCDEF');
      expect(
        (
          await c.query(
            `SELECT tgenabled FROM pg_trigger WHERE tgname='membership_identity_guard' AND tgrelid='workspace_memberships'::regclass`,
          )
        ).rows,
      ).toEqual([{ tgenabled: 'O' }]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
