import { randomUUID } from 'node:crypto';
import { setTimeout as waitUntilExpiry } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { installE2eSessionMiddleware } from './e2e-session-middleware';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';

type Agent = ReturnType<typeof request.agent>;
const responsibilityFields = [
  'listingId',
  'workspaceId',
  'responsibleMembershipId',
  'revision',
];
const transferFields = [
  'id',
  'listingId',
  'workspaceId',
  'status',
  'sourceMembershipId',
  'targetMembershipId',
  'expiresAt',
  'createdAt',
];
const privateFields = [
  'assignment_sequence',
  'assignmentSequence',
  'workspace_id',
  'responsible_membership_id',
  'expectedOwnershipRevision',
  'expectedListingRevision',
  'expectedSourceRevision',
  'expectedTargetRevision',
  'commandId',
  'correlationId',
  'decidedAt',
  'decidedByMembershipId',
];
function publicBody(
  response: Response,
  fields: string[],
): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  const data = value as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual([...fields].sort());
  for (const name of Object.keys(data)) expect(name).not.toContain('_');
  for (const name of privateFields) expect(data).not.toHaveProperty(name);
  return data;
}

jest.setTimeout(60000);
describe('Listing assignment public HTTP contracts with restricted application login', () => {
  const f = new ListingWorkspaceFixture();
  let app: INestApplication;
  let owner: Agent, source: Agent, target: Agent;
  let workspaceId: string,
    listingId: string,
    sourceId: string,
    targetId: string;
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
    process.env['SESSION_SECRET'] =
      'assignment-http-session-secret-at-least-32-characters';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(
        prismaServiceWithSharedPool(
          f.applicationRuntime,
          f.applicationPool,
          f.schema,
        ),
      )
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    installE2eSessionMiddleware(app);
    await app.init();
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await f.stop();
    }
  });
  function server() {
    return app.getHttpServer() as Parameters<typeof request>[0];
  }
  async function register() {
    const agent = request.agent(server());
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: 'Assignment actor',
        email: `${randomUUID()}@assignment-http.test`,
        password: 'StrongPass123',
        role: 'provider',
        providerType: 'private',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    return { agent, id: (response.body as { id: string }).id };
  }
  beforeEach(async () => {
    const actors = [await register(), await register(), await register()];
    owner = actors[0].agent;
    source = actors[1].agent;
    target = actors[2].agent;
    const workspace = await f.workspaceFor(actors[0].id);
    workspaceId = workspace.id;
    sourceId = randomUUID();
    targetId = randomUUID();
    await f.runtimeSql(workspaceId, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspaceId,
      ]);
      for (const [id, userId] of [
        [sourceId, actors[1].id],
        [targetId, actors[2].id],
      ])
        await c.query(
          `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES($1,$2,$3,'AGENT','#7C3AED')`,
          [id, workspaceId, userId],
        );
    });
    listingId = await f.listing(workspaceId, workspace.owner, sourceId);
  });
  function input(revision = 1, member = targetId) {
    return {
      targetMembershipId: member,
      expectedListingRevision: revision,
      commandId: randomUUID(),
      correlationId: randomUUID(),
    };
  }
  function responsibility() {
    return `/api/v1/provider/listings/${listingId}/responsibility`;
  }
  function requests() {
    return `/api/v1/provider/listings/${listingId}/transfer-requests`;
  }
  async function createTransfer(validForMs = 300000) {
    const command = {
      ...input(),
      expiresAt: new Date(Date.now() + validForMs).toISOString(),
    };
    const response = await source
      .post(requests())
      .set('x-workspace-id', workspaceId)
      .send(command)
      .expect(201);
    const data = publicBody(response, transferFields);
    expect(data).toMatchObject({
      listingId,
      workspaceId,
      status: 'REQUESTED',
      sourceMembershipId: sourceId,
      targetMembershipId: targetId,
      expiresAt: command.expiresAt,
    });
    expect(data['createdAt']).toEqual(expect.any(String));
    return { id: data['id'] as string, data, command };
  }
  it('returns the same exact camelCase responsibility shape for mutation and no-op', async () => {
    const mutation = publicBody(
      await owner
        .patch(responsibility())
        .set('x-workspace-id', workspaceId)
        .send(input())
        .expect(200),
      responsibilityFields,
    );
    expect(mutation).toEqual({
      listingId,
      workspaceId,
      responsibleMembershipId: targetId,
      revision: 2,
    });
    const noOpCommand = input(2);
    for (let attempt = 0; attempt < 2; attempt++) {
      const noOp = publicBody(
        await owner
          .patch(responsibility())
          .set('x-workspace-id', workspaceId)
          .send(noOpCommand)
          .expect(200),
        responsibilityFields,
      );
      expect(noOp).toEqual(mutation);
    }
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { listingId },
      }),
    ).toBe(2);
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: listingId } }),
    ).toMatchObject({ revision: 2, assignmentSequence: 2 });
  });
  it('redacts transfer creation and idempotent replay while retaining private evidence in persistence', async () => {
    const created = await createTransfer();
    const replay = publicBody(
      await source
        .post(requests())
        .set('x-workspace-id', workspaceId)
        .send(created.command)
        .expect(201),
      transferFields,
    );
    expect(replay).toEqual(created.data);
    expect(
      await f.prisma.listingTransferRequest.count({ where: { listingId } }),
    ).toBe(1);
    expect(
      await f.prisma.listingTransferRequest.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toMatchObject({
      commandId: created.command.commandId,
      correlationId: created.command.correlationId,
      expectedOwnershipRevision: 1,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    });
  });
  it.each([
    ['approve', 'APPROVED'],
    ['reject', 'REJECTED'],
    ['cancel', 'CANCELLED'],
  ] as const)(
    'allowlists %s responses and rejects duplicate completion',
    async (action, status) => {
      const created = await createTransfer();
      const actor = action === 'cancel' ? source : owner;
      const path = `/api/v1/provider/listing-transfer-requests/${created.id}/${action}`;
      const decided = publicBody(
        await actor.post(path).set('x-workspace-id', workspaceId).expect(201),
        transferFields,
      );
      expect(decided).toEqual({ ...created.data, status });
      await actor.post(path).set('x-workspace-id', workspaceId).expect(409);
      expect(
        await f.prisma.listing.findUniqueOrThrow({ where: { id: listingId } }),
      ).toMatchObject({
        responsibleMembershipId: action === 'approve' ? targetId : sourceId,
        revision: action === 'approve' ? 2 : 1,
      });
    },
  );
  it('requires authentication and explicit selection for responsibility and transfer creation', async () => {
    await request(server()).patch(responsibility()).send(input()).expect(401);
    await owner.patch(responsibility()).send(input()).expect(404);
    await source
      .post(requests())
      .send({
        ...input(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      })
      .expect(404);
    await owner
      .patch(responsibility())
      .set('x-workspace-id', randomUUID())
      .send(input())
      .expect(404);
    await source
      .patch(responsibility())
      .set('x-workspace-id', workspaceId)
      .send(input())
      .expect(403);
  });
  it('returns 409 after real transfer expiry without changing responsibility or evidence', async () => {
    const created = await createTransfer(1000);
    // Wait for the actual persisted deadline; neither clocks nor SQL guards are mocked.
    await waitUntilExpiry(
      Math.max(0, Date.parse(created.command.expiresAt) - Date.now() + 1),
    );
    const response = await owner
      .post(`/api/v1/provider/listing-transfer-requests/${created.id}/approve`)
      .set('x-workspace-id', workspaceId)
      .expect(409);
    expect((response.body as { message: string }).message).toBe(
      'Transfer request is stale or ineligible',
    );
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: listingId } }),
    ).toMatchObject({ responsibleMembershipId: sourceId, revision: 1 });
    expect(
      await f.prisma.listingTransferRequest.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toMatchObject({ status: 'REQUESTED', decidedAt: null });
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { listingId },
      }),
    ).toBe(1);
  });
  it('translates the real nested SQL stale-membership guard failure into 409', async () => {
    const created = await createTransfer();
    await f.runtimeSql(workspaceId, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspaceId,
      ]);
      for (const status of ['SUSPENDED', 'ACTIVE'])
        await c.query(
          `UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1`,
          [targetId, status],
        );
    });
    const response = await owner
      .post(`/api/v1/provider/listing-transfer-requests/${created.id}/approve`)
      .set('x-workspace-id', workspaceId)
      .expect(409);
    expect((response.body as { message: string }).message).toBe(
      'Transfer request is stale or ineligible',
    );
    expect(
      await f.prisma.listingTransferRequest.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toMatchObject({ status: 'REQUESTED', decidedAt: null });
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: listingId } }),
    ).toMatchObject({ responsibleMembershipId: sourceId, revision: 1 });
  });
  it('preserves decision role checks, hidden foreign requests and required selectors', async () => {
    const created = await createTransfer();
    const path = `/api/v1/provider/listing-transfer-requests/${created.id}`;
    await owner.post(`${path}/approve`).expect(404);
    await owner
      .post(`${path}/approve`)
      .set('x-workspace-id', randomUUID())
      .expect(404);
    await source
      .post(`${path}/approve`)
      .set('x-workspace-id', workspaceId)
      .expect(403);
    await target
      .post(`${path}/cancel`)
      .set('x-workspace-id', workspaceId)
      .expect(404);
    expect(
      (
        await f.prisma.listingTransferRequest.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).status,
    ).toBe('REQUESTED');
  });
});
