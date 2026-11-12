import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { installE2eSessionMiddleware } from './e2e-session-middleware';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';

jest.setTimeout(60000);
describe('Session-authoritative workspace discovery through restricted login', () => {
  const f = new ListingWorkspaceFixture();
  let app: INestApplication;
  let foreign: Awaited<ReturnType<ListingWorkspaceFixture['organization']>>;
  beforeAll(async () => {
    await f.start();
    foreign = await f.organization();
    await f.activateApplication();
    await f.pool.query(
      readFileSync(
        'prisma/migrations/20261111180000_workspace_discovery/migration.sql',
        'utf8',
      ),
    );
    process.env['SESSION_SECRET'] =
      'workspace-discovery-e2e-session-secret-at-least-32';
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
    installE2eSessionMiddleware(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await f.stop();
  });
  function server() {
    return app.getHttpServer() as Parameters<typeof request>[0];
  }
  async function provider() {
    const agent = request.agent(server());
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: 'Workspace discovery',
        email: `${randomUUID()}@discovery.test`,
        password: 'StrongPass123',
        role: 'provider',
        providerType: 'private',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    return { agent, id: (response.body as { id: string }).id };
  }
  async function enroll(
    userId: string,
    workspaceId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED' = 'ACTIVE',
  ) {
    const id = randomUUID();
    await f.runtimeSql(workspaceId, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspaceId,
      ]);
      await c.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES($1,$2,$3,'AGENT','#7C3AED')`,
        [id, workspaceId, userId],
      );
      if (status !== 'ACTIVE')
        await c.query(
          `UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1`,
          [id, status],
        );
    });
    return id;
  }
  it('requires authentication', async () => {
    await request(server()).get('/api/v1/provider/workspaces').expect(401);
  });
  it('returns an empty list for zero memberships without leaking a candidate header', async () => {
    const { agent } = await provider();
    const response = await agent
      .get('/api/v1/provider/workspaces')
      .set('x-workspace-id', foreign.id)
      .expect(200);
    expect(response.body).toEqual([]);
  });
  it('returns only the four allowlisted facts for one PERSONAL membership', async () => {
    const { agent, id } = await provider();
    const input = f.command(id, 'PERSONAL');
    await f.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await f.establishment.withinTransaction(tx, input);
    });
    const response = await agent.get('/api/v1/provider/workspaces').expect(200);
    expect(response.body).toEqual([
      {
        workspaceId: input.workspaceId,
        membershipId: input.membershipId,
        role: 'OWNER',
        kind: 'PERSONAL',
      },
    ]);
    await agent.get('/api/v1/provider/listings').expect(404);
    await agent
      .get('/api/v1/me/onboarding-state')
      .expect(200)
      .expect({ role: 'provider', nextStep: 'select_workspace' });
    await agent
      .get('/api/v1/me/onboarding-state')
      .set('x-workspace-id', input.workspaceId)
      .expect(200)
      .expect({
        role: 'provider',
        hasCreatedFirstListing: false,
        nextStep: 'create_first_listing',
      });
  });
  it('discovers organization AGENT membership without exposing foreign members or workspaces', async () => {
    const { agent, id } = await provider();
    const member = await enroll(id, foreign.id);
    const response = await agent.get('/api/v1/provider/workspaces').expect(200);
    expect(response.body).toEqual([
      {
        workspaceId: foreign.id,
        membershipId: member,
        role: 'AGENT',
        kind: 'ORGANIZATION',
      },
    ]);
  });
  it('returns multiple ACTIVE memberships deterministically and never chooses the first for operations', async () => {
    const { agent, id } = await provider();
    const own = await f.workspaceFor(id);
    const member = await enroll(id, foreign.id);
    const response = await agent.get('/api/v1/provider/workspaces').expect(200);
    expect(response.body).toEqual(
      [
        {
          workspaceId: own.id,
          membershipId: own.owner,
          role: 'OWNER',
          kind: 'ORGANIZATION',
        },
        {
          workspaceId: foreign.id,
          membershipId: member,
          role: 'AGENT',
          kind: 'ORGANIZATION',
        },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    );
    await agent.get('/api/v1/provider/listings').expect(404);
    await agent
      .get('/api/v1/me/onboarding-state')
      .expect(200)
      .expect({ role: 'provider', nextStep: 'select_workspace' });
    await agent
      .get('/api/v1/provider/listings')
      .set('x-workspace-id', own.id)
      .expect(200);
    await agent
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', own.id)
      .send({ city: 'Berlin' })
      .expect(503);
  });
  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'omits %s memberships',
    async (status) => {
      const { agent, id } = await provider();
      await enroll(id, foreign.id, status);
      await agent.get('/api/v1/provider/workspaces').expect(200).expect([]);
      await agent
        .get('/api/v1/provider/listings')
        .set('x-workspace-id', foreign.id)
        .expect(404);
    },
  );
  it('omits CLOSING workspaces', async () => {
    const { agent, id } = await provider();
    const own = await f.workspaceFor(id);
    await f.tx(async (tx) => {
      await installTenantContext(tx, own.id);
      await f.lifecycle.beginClosingWithinTransaction(tx, own.id, 1);
    });
    await agent.get('/api/v1/provider/workspaces').expect(200).expect([]);
  });
  it('denies foreign and nonexistent operational selection identically', async () => {
    const { agent } = await provider();
    for (const ws of [foreign.id, randomUUID()])
      await agent
        .get('/api/v1/provider/listings')
        .set('x-workspace-id', ws)
        .expect(404);
  });
  it('does not expose base rows, grant helper-role membership, or leave discovery identity on a pooled connection', async () => {
    const user = await f.user();
    await enroll(user, foreign.id);
    await f.applicationSql(null, async (c) => {
      const rows = await c.query(
        'SELECT * FROM discover_active_workspaces($1)',
        [user],
      );
      expect(rows.rowCount).toBe(1);
      expect(
        (await c.query('SELECT id FROM workspace_memberships')).rows,
      ).toEqual([]);
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([]);
      expect(
        (
          await c.query<{ identity: string | null }>(
            "SELECT nullif(current_setting('app.workspace_discovery_user',true),'') AS identity",
          )
        ).rows[0].identity,
      ).toBeNull();
      expect(
        (
          await c.query<{ member: boolean }>(
            "SELECT pg_has_role(current_user,'renyqo_workspace_discovery','MEMBER') AS member",
          )
        ).rows[0].member,
      ).toBe(false);
    });
  });
  it('serializes provider listing details without undeclared assignment/internal fields', async () => {
    const { agent, id } = await provider();
    const own = await f.workspaceFor(id);
    const listing = await f.listing(own.id, own.owner);
    const response = await agent
      .get(`/api/v1/provider/listings/${listing}`)
      .set('x-workspace-id', own.id)
      .expect(200);
    expect(response.body).toMatchObject({
      id: listing,
      workspaceId: own.id,
      revision: 1,
    });
    for (const key of [
      'assignmentSequence',
      'retiredAt',
      'displayOrder',
      'criteriaRevision',
      '_count',
    ])
      expect(response.body).not.toHaveProperty(key);
  });
  it('rejects discovery after global authVersion revocation', async () => {
    const { agent, id } = await provider();
    await f.prisma.user.update({
      where: { id },
      data: { authVersion: { increment: 1 } },
    });
    await agent.get('/api/v1/provider/workspaces').expect(401);
  });
});
