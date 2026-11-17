import { randomUUID } from 'node:crypto';
import { CapabilityFixture } from './provider-capabilities.fixture';
jest.setTimeout(60000);
describe('Entitlement protected HTTP creation and replay', () => {
  const f = new CapabilityFixture();
  beforeAll(() => f.start(4));
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.stop());
  async function cap(index: number, max = 1) {
    const w = f.workspaces[index],
      id = randomUUID();
    await f.db.pool.query(
      `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats) VALUES($1::uuid,$1::text,1,'ORGANIZATION',$2,3)`,
      [id, max],
    );
    await f.db.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_plan_assignments SET plan_version_id=$1,source='INTERNAL',command_id=$2,actor_membership_id=$3 WHERE workspace_id=$4`,
        [id, randomUUID(), w.owner, w.id],
      );
    });
    return w;
  }
  it('creates, replays at full capacity, rejects changed input and protects creation-only fields', async () => {
    const w = await cap(0),
      client = await f.login(w.ownerUser),
      commandId = randomUUID();
    const first = await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId, title: 'Original' })
      .expect(201);
    const id = (first.body as { id: string }).id;
    const replay = await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId, title: 'Original' })
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(id);
    const changed = await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId, title: 'Changed' })
      .expect(409);
    expect(changed.body).toMatchObject({ code: 'CREATION_COMMAND_CONFLICT' });
    const full = await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId: randomUUID() })
      .expect(409);
    expect(full.body).toMatchObject({ code: 'LISTING_LIMIT_REACHED' });
    await client
      .patch(`/api/v1/provider/listings/${id}`)
      .set('x-workspace-id', w.id)
      .send({ responsibleMembershipId: w.agents[0].id })
      .expect(400);
    const projection = await client
      .get('/api/v1/provider/workspace-entitlements')
      .set('x-workspace-id', w.id)
      .expect(200);
    expect(projection.body).toMatchObject({
      usedListings: 1,
      acceptedSeats: 3,
      reservedSeats: 0,
      remainingListings: 0,
    });
    await f.db.prisma.user.update({
      where: { id: w.ownerUser },
      data: { authVersion: { increment: 1 } },
    });
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId, title: 'Original' })
      .expect(401);
  });
  it('capability cannot bypass quota and a plan cannot grant capabilities', async () => {
    const w = await cap(1),
      client = await f.login(w.agents[0].userId);
    f.restrictAgents([]);
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId: randomUUID() })
      .expect(403);
    jest.restoreAllMocks();
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId: randomUUID() })
      .expect(201);
    await client
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send({ commandId: randomUUID() })
      .expect(409);
    await client
      .get('/api/v1/provider/workspace-entitlements')
      .set('x-workspace-id', w.id)
      .expect(403);
  });
  it('collapses foreign selection and refuses mock activation by default', async () => {
    const w = await cap(2),
      client = await f.login(w.ownerUser);
    for (const workspace of [f.workspaces[3].id, randomUUID()])
      await client
        .post('/api/v1/provider/listings')
        .set('x-workspace-id', workspace)
        .send({ commandId: randomUUID() })
        .expect(404);
    await client
      .post('/api/v1/provider/workspace-entitlements/mock-activation')
      .set('x-workspace-id', w.id)
      .send({
        planVersionId: randomUUID(),
        commandId: randomUUID(),
        expectedRevision: 1,
        expectedOwnershipRevision: 1,
      })
      .expect(404);
  });
  it('records explicit mock activation and refuses it in production even with the switch enabled', async () => {
    const w = await cap(3, 2),
      client = await f.login(w.ownerUser);
    const previous = {
      node: process.env['NODE_ENV'],
      enabled: process.env['ENABLE_MOCK_PLAN_ACTIVATION'],
    };
    const assignment =
      await f.db.prisma.workspacePlanAssignment.findUniqueOrThrow({
        where: { workspaceId: w.id },
      });
    const input = {
      planVersionId: assignment.planVersionId,
      commandId: randomUUID(),
      expectedRevision: assignment.revision,
      expectedOwnershipRevision: 1,
    };
    try {
      process.env['ENABLE_MOCK_PLAN_ACTIVATION'] = 'true';
      const stale = await client
        .post('/api/v1/provider/workspace-entitlements/mock-activation')
        .set('x-workspace-id', w.id)
        .send({ ...input, expectedOwnershipRevision: 2 })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'OWNERSHIP_REVISION_CONFLICT' });
      await client
        .post('/api/v1/provider/workspace-entitlements/mock-activation')
        .set('x-workspace-id', w.id)
        .send(input)
        .expect(201);
      const change = await f.db.prisma.workspacePlanChange.findUniqueOrThrow({
        where: {
          workspaceId_commandId: {
            workspaceId: w.id,
            commandId: input.commandId,
          },
        },
      });
      expect(change.source).toBe('MOCK_DEV');
      process.env['NODE_ENV'] = 'production';
      await client
        .post('/api/v1/provider/workspace-entitlements/mock-activation')
        .set('x-workspace-id', w.id)
        .send(input)
        .expect(404);
    } finally {
      if (previous.node === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous.node;
      if (previous.enabled === undefined)
        delete process.env['ENABLE_MOCK_PLAN_ACTIVATION'];
      else process.env['ENABLE_MOCK_PLAN_ACTIVATION'] = previous.enabled;
    }
  });
});
