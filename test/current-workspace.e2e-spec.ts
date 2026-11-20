import { randomUUID } from 'node:crypto';
import { CapabilityFixture } from './provider-capabilities.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import type { CurrentWorkspaceDto } from '../src/provider-workspaces/projections/current-workspace.dto';

jest.setTimeout(60000);
describe('Current workspace presentation through restricted runtime', () => {
  const f = new CapabilityFixture();
  const path = '/api/v1/provider/workspaces/current';
  beforeAll(() => f.start(4));
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.stop());

  async function selected(user: string, workspace: string) {
    return (await f.login(user)).get(path).set('x-workspace-id', workspace);
  }
  async function limit(index: number, max: number, force = false) {
    const w = f.workspaces[index],
      id = randomUUID();
    await f.db.pool.query(
      `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats)
       VALUES($1::uuid,$1::text,1,'ORGANIZATION',$2,3)`,
      [id, max],
    );
    await f.db.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_plan_assignments SET plan_version_id=$1,source='INTERNAL',change_mode=$2,
         command_id=$3,actor_membership_id=$4 WHERE workspace_id=$5`,
        [id, force ? 'FORCED' : 'VOLUNTARY', randomUUID(), w.owner, w.id],
      );
    });
  }
  it('returns only canonical workspace, current member and operational action for OWNER and AGENT', async () => {
    const w = f.workspaces[0];
    await f.db.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        "UPDATE provider_workspaces SET display_name='Selected workspace',revision=revision+1 WHERE id=$1",
        [w.id],
      );
    });
    for (const [userId, membershipId, role] of [
      [w.ownerUser, w.owner, 'OWNER'],
      [w.agents[0].userId, w.agents[0].id, 'AGENT'],
    ]) {
      const response = await selected(userId, w.id);
      expect(response.status).toBe(200);
      const member = await f.db.prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membershipId },
      });
      expect(response.body).toEqual({
        workspace: {
          id: w.id,
          displayName: 'Selected workspace',
          kind: 'ORGANIZATION',
        },
        membership: { id: membershipId, role, colorId: member.displayColor },
        actions: {
          createListing: { allowed: true, reason: null },
          reorderListings: { allowed: role === 'OWNER' },
        },
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['vary']).toContain('x-workspace-id');
    }
  });
  it('uses full workspace capacity even when the AGENT has no responsible listings; query reserves nothing', async () => {
    const w = f.workspaces[1];
    await limit(1, 1);
    const client = await f.login(w.agents[0].userId);
    await client
      .get(path)
      .set('x-workspace-id', w.id)
      .expect(200)
      .expect(({ body }) =>
        expect((body as CurrentWorkspaceDto).actions.createListing).toEqual({
          allowed: true,
          reason: null,
        }),
      );
    await f.db.listing(w.id, w.owner);
    const response = await client
      .get(path)
      .set('x-workspace-id', w.id)
      .expect(200);
    expect(
      (response.body as CurrentWorkspaceDto).actions.createListing,
    ).toEqual({
      allowed: false,
      reason: 'WORKSPACE_GROWTH_UNAVAILABLE',
    });
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId: randomUUID() })
      .expect(409);
    expect(
      await f.db.prisma.workspaceSeatReservation.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.listing.count({ where: { workspaceId: w.id } }),
    ).toBe(1);
  });
  it('maps missing capabilities without exposing entitlement state', async () => {
    const w = f.workspaces[0];
    f.restrictAgents(['LISTING_READ']);
    const response = await selected(w.agents[0].userId, w.id);
    expect(response.status).toBe(200);
    expect(
      (response.body as CurrentWorkspaceDto).actions.createListing,
    ).toEqual({
      allowed: false,
      reason: 'NOT_PERMITTED',
    });
  });
  it('coarsens unassigned and forced OVER_LIMIT into the same growth reason', async () => {
    const unassigned = f.workspaces[2],
      over = f.workspaces[3];
    await f.db.runtimeSql(unassigned.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        unassigned.id,
      ]);
      await c.query(
        `UPDATE workspace_plan_assignments SET plan_version_id=NULL,source='INTERNAL',
        change_mode='FORCED',command_id=$1,actor_membership_id=$2 WHERE workspace_id=$3`,
        [randomUUID(), unassigned.owner, unassigned.id],
      );
    });
    await f.db.listing(over.id, over.owner);
    await f.db.listing(over.id, over.owner);
    await limit(3, 1, true);
    for (const w of [unassigned, over]) {
      const response = await selected(w.agents[0].userId, w.id);
      expect(response.status).toBe(200);
      expect(
        (response.body as CurrentWorkspaceDto).actions.createListing,
      ).toEqual({
        allowed: false,
        reason: 'WORKSPACE_GROWTH_UNAVAILABLE',
      });
    }
  });
  it('supports PERSONAL identity and its structural one-listing limit', async () => {
    const ownerUser = f.workspaces[0].ownerUser;
    const input = f.db.command(ownerUser, 'PERSONAL');
    input.displayName = 'Personal portfolio';
    await f.db.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await f.db.establishment.withinTransaction(tx, input);
    });
    const response = await selected(ownerUser, input.workspaceId);
    expect(response.status).toBe(200);
    expect((response.body as CurrentWorkspaceDto).workspace).toEqual({
      id: input.workspaceId,
      displayName: input.displayName,
      kind: 'PERSONAL',
    });
    expect((response.body as CurrentWorkspaceDto).membership.id).toBe(
      input.membershipId,
    );
    expect(
      (response.body as CurrentWorkspaceDto).actions.createListing.allowed,
    ).toBe(true);
    await f.db.listing(input.workspaceId, input.membershipId);
    const full = await selected(ownerUser, input.workspaceId);
    expect((full.body as CurrentWorkspaceDto).actions.createListing).toEqual({
      allowed: false,
      reason: 'WORKSPACE_GROWTH_UNAVAILABLE',
    });
  });
  it('an allowed projection reserves no slot and competing creation commands still enforce the final slot', async () => {
    const w = f.workspaces[0];
    await limit(0, 1);
    const owner = await f.login(w.ownerUser),
      agent = await f.login(w.agents[0].userId);
    for (const client of [owner, agent]) {
      const response = await client
        .get(path)
        .set('x-workspace-id', w.id)
        .expect(200);
      expect(
        (response.body as CurrentWorkspaceDto).actions.createListing,
      ).toEqual({
        allowed: true,
        reason: null,
      });
    }
    const responses = await Promise.all(
      [owner, agent].map((client) =>
        client
          .post('/api/v1/provider/listings')
          .set('x-workspace-id', w.id)
          .send({ commandId: randomUUID() }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await f.db.prisma.listing.count({ where: { workspaceId: w.id } }),
    ).toBe(1);
  });
  it('keeps missing, invalid, foreign and nonexistent selections unavailable', async () => {
    const w = f.workspaces[0],
      client = await f.login(w.ownerUser);
    await client.get(path).expect(404);
    for (const id of ['invalid', randomUUID(), f.workspaces[1].id]) {
      const response = await client
        .get(path)
        .set('x-workspace-id', id)
        .expect(404);
      expect((response.body as { message: string }).message).toBe(
        'Workspace not found',
      );
    }
  });
  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'denies %s membership',
    async (status) => {
      const w = f.workspaces[2],
        member = w.agents[status === 'SUSPENDED' ? 0 : 1];
      const client = await f.login(member.userId);
      await f.db.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          'UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1',
          [member.id, status],
        );
      });
      await client.get(path).set('x-workspace-id', w.id).expect(404);
    },
  );
  it('switches between requests without retaining context and denies revoked session authority', async () => {
    const user = f.workspaces[0].ownerUser,
      client = await f.login(user);
    const other = await f.db.workspaceFor(user);
    for (const w of [f.workspaces[0], other, f.workspaces[0]]) {
      const response = await client
        .get(path)
        .set('x-workspace-id', w.id)
        .expect(200);
      expect((response.body as CurrentWorkspaceDto).workspace.id).toBe(w.id);
      expect((response.body as CurrentWorkspaceDto).membership.id).toBe(
        w.owner,
      );
    }
    await f.db.prisma.user.update({
      where: { id: user },
      data: { authVersion: { increment: 1 } },
    });
    await client.get(path).set('x-workspace-id', other.id).expect(401);
  });
});
