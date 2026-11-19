import { randomUUID } from 'node:crypto';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { admitFixtureAgent } from './invitation-admission.fixture';
import { MEMBER_COLOR_IDS } from '../src/member-presentation/member-color.catalog';
jest.setTimeout(60000);
describe('Restricted PostgreSQL member color invariants', () => {
  const f = new ListingWorkspaceFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('assigns the first OWNER and controls reuse after the complete palette is occupied', async () => {
    const w = await f.workspaceFor(await f.user());
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: w.owner },
        })
      ).displayColor,
    ).toBe('ROYAL_BLUE');
    for (let n = 1; n < MEMBER_COLOR_IDS.length + 2; n++) {
      const member = await admitFixtureAgent(f, w.id, await f.user());
      expect(
        (
          await f.prisma.workspaceMembership.findUniqueOrThrow({
            where: { id: member },
          })
        ).displayColor,
      ).toBe(MEMBER_COLOR_IDS[n % MEMBER_COLOR_IDS.length]);
    }
  });
  it('SUSPENDED reserves a color, REMOVED releases selection usage, reinstatement preserves original identity/color even after reuse', async () => {
    const w = await f.workspaceFor(await f.user()),
      id = await admitFixtureAgent(f, w.id, await f.user());
    const old = await f.prisma.workspaceMembership.findUniqueOrThrow({
      where: { id },
    });
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
        [id],
      );
    });
    const second = await admitFixtureAgent(f, w.id, await f.user());
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: second },
        })
      ).displayColor,
    ).not.toBe(old.displayColor);
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [id],
      );
    });
    const replacement = await admitFixtureAgent(f, w.id, await f.user());
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: replacement },
        })
      ).displayColor,
    ).toBe(old.displayColor);
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='ACTIVE' WHERE id=$1`,
        [id],
      );
    });
    expect(
      (await f.prisma.workspaceMembership.findUniqueOrThrow({ where: { id } }))
        .displayColor,
    ).toBe(old.displayColor);
    expect(
      await f.prisma.workspaceMembership.count({
        where: { workspaceId: w.id, userId: old.userId },
      }),
    ).toBe(1);
  });
  it('rejects recolor and arbitrary raw identifiers and preserves RLS visibility', async () => {
    const w = await f.workspaceFor(await f.user()),
      id = await admitFixtureAgent(f, w.id, await f.user());
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `UPDATE workspace_memberships SET display_color='MAGENTA' WHERE id=$1`,
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES($1,$2,$3,'AGENT','#FF0000')`,
          [randomUUID(), w.id, await f.user()],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'member_color_identifier' });
    expect(
      await f.runtimeSql(
        null,
        async (c) =>
          (await c.query('SELECT id,display_color FROM workspace_memberships'))
            .rowCount,
      ),
    ).toBe(0);
  });
});
