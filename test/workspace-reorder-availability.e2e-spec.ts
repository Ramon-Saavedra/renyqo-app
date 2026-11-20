import { CapabilityFixture } from './provider-capabilities.fixture';
import type { CurrentWorkspaceDto } from '../src/provider-workspaces/projections/current-workspace.dto';

jest.setTimeout(60000);
describe('Server-derived reorder action and independent mutation authority', () => {
  const f = new CapabilityFixture();
  const current = '/api/v1/provider/workspaces/current';
  beforeAll(() => f.start(2));
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.stop());

  it('allows OWNER reordering and independently denies an assigned AGENT mutation', async () => {
    const w = f.workspaces[0];
    const first = await f.db.listing(w.id, w.owner, w.agents[0].id);
    await f.db.listing(w.id, w.owner);
    const owner = await f.login(w.ownerUser),
      agent = await f.login(w.agents[0].userId);
    for (const [client, allowed] of [
      [owner, true],
      [agent, false],
    ] as const) {
      const response = await client
        .get(current)
        .set('x-workspace-id', w.id)
        .expect(200);
      const result = response.body as CurrentWorkspaceDto;
      expect(result.actions).toEqual({
        createListing: { allowed: true, reason: null },
        reorderListings: { allowed },
      });
      expect(Object.keys(result).sort()).toEqual([
        'actions',
        'membership',
        'workspace',
      ]);
      expect(Object.keys(result.workspace).sort()).toEqual([
        'displayName',
        'id',
        'kind',
      ]);
      expect(Object.keys(result.membership).sort()).toEqual([
        'colorId',
        'id',
        'role',
      ]);
    }
    // Ignoring the false UI flag cannot confer authority on a direct API call.
    await agent
      .patch(`/api/v1/provider/listings/${first}/position`)
      .set('x-workspace-id', w.id)
      .send({ position: 2 })
      .expect(403);
    expect(
      (await f.db.prisma.listing.findUniqueOrThrow({ where: { id: first } }))
        .displayOrder,
    ).toBe(1);
    await owner
      .patch(`/api/v1/provider/listings/${first}/position`)
      .set('x-workspace-id', w.id)
      .send({ position: 2 })
      .expect(200);
    expect(
      (await f.db.prisma.listing.findUniqueOrThrow({ where: { id: first } }))
        .displayOrder,
    ).toBe(2);
  });
  it('retains createListing denial independently and exposes no foreign workspace', async () => {
    const w = f.workspaces[0],
      client = await f.login(w.agents[0].userId);
    f.restrictAgents([]);
    const response = await client
      .get(current)
      .set('x-workspace-id', w.id)
      .expect(200);
    expect((response.body as CurrentWorkspaceDto).actions).toEqual({
      createListing: { allowed: false, reason: 'NOT_PERMITTED' },
      reorderListings: { allowed: false },
    });
    await client
      .get(current)
      .set('x-workspace-id', f.workspaces[1].id)
      .expect(404);
  });
  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'denies %s memberships before producing action data',
    async (status) => {
      const w = f.workspaces[1],
        member = w.agents[status === 'SUSPENDED' ? 0 : 1];
      const client = await f.login(member.userId);
      const listing = await f.db.listing(w.id, w.owner);
      await f.db.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          'UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1',
          [member.id, status],
        );
      });
      const response = await client
        .get(current)
        .set('x-workspace-id', w.id)
        .expect(404);
      expect(response.body).not.toHaveProperty('actions');
      await client
        .patch(`/api/v1/provider/listings/${listing}/position`)
        .set('x-workspace-id', w.id)
        .send({ position: 1 })
        .expect(404);
    },
  );
});
