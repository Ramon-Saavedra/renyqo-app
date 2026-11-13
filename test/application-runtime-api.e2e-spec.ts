import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { installE2eSessionMiddleware } from './e2e-session-middleware';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { ViewingWorkflowExpiryService } from '../src/application-viewings/viewing-workflow-expiry.service';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { DocumentRecoveryService } from '../src/application-documents/worker/document-recovery.service';
import { ApplicationDocumentFinalizationService } from '../src/application-documents/application-document-finalization.service';
import { ListingCreation } from '../src/listings/listing-creation';
import { ListingsService } from '../src/listings/listings.service';

jest.setTimeout(60000);
describe('API/session/worker smoke through restricted application login', () => {
  const f = new ListingWorkspaceFixture();
  let app: INestApplication;
  let workspaces: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[];
  beforeAll(async () => {
    await f.start();
    workspaces = [await f.organization(), await f.organization()];
    await f.activateApplication();
    process.env['SESSION_SECRET'] =
      'restricted-application-e2e-session-secret-at-least-32';
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
    await app?.close();
    await f.stop();
  });
  it('registers, persists session/grant, edits profile and logs out through the new credential', async () => {
    const agent = request.agent(
      app.getHttpServer() as Parameters<typeof request>[0],
    );
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: 'Restricted Applicant',
        email: `${randomUUID()}@runtime.test`,
        password: 'StrongPass123',
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const userId = (response.body as { id: string }).id;
    expect(
      await f.applicationRuntime.sessionAuthGrant.count({ where: { userId } }),
    ).toBe(1);
    await agent
      .patch('/api/v1/applicant/profile')
      .send({
        introduction:
          'A valid applicant introduction for the restricted runtime smoke test.',
      })
      .expect(200);
    expect(
      await f.applicationRuntime.applicantProfile.findUnique({
        where: { applicantId: userId },
      }),
    ).not.toBeNull();
    await agent.get('/api/v1/applicant/applications/overview').expect(200);
    await agent.get('/api/v1/listings').expect(200);
    await agent.post('/api/v1/auth/logout').expect(200);
    expect(
      await f.applicationRuntime.sessionAuthGrant.count({ where: { userId } }),
    ).toBe(0);
  });
  it('runs existing expiry, outbox and document recovery database scans with the application login', async () => {
    await app.get(ViewingWorkflowExpiryService).runOnce(5);
    await app.get(OutboxDispatcherService).dispatchOnce();
    const recovery = new DocumentRecoveryService(
      f.applicationRuntime as PrismaService,
      app.get(ApplicationDocumentFinalizationService),
    );
    await recovery.run();
  });
  it.each(['read', 'mutation'] as const)(
    'hides foreign, missing and WAITING applications behind the same provider HTTP %s contract',
    async (operation) => {
      const agent = request.agent(
        app.getHttpServer() as Parameters<typeof request>[0],
      );
      const registered = await agent
        .post('/api/v1/auth/register')
        .send({
          name: 'Application scope provider',
          email: `${randomUUID()}@runtime.test`,
          password: 'StrongPass123',
          role: 'provider',
          providerType: 'private',
          acceptedTerms: true,
          acceptedPrivacy: true,
        })
        .expect(201);
      const userId = (registered.body as { id: string }).id;
      const workspace = await f.workspaceFor(userId);
      const ownListing = await f.listing(workspace.id, workspace.owner);
      const foreignListing = await f.listing(
        workspaces[0].id,
        workspaces[0].owner,
      );
      await f.applicationSql(workspace.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          workspace.id,
        ]);
        await c.query(
          `UPDATE listings SET status='published',published_at=clock_timestamp() WHERE id=$1`,
          [ownListing],
        );
      });
      const createApplication = async (listingId: string, waiting = false) =>
        f.prisma.application.create({
          data: {
            listingId,
            applicantId: await f.user(),
            status: waiting ? 'WAITING' : 'ACTIVE',
            activeAt: waiting ? null : new Date(),
          },
        });
      const own = await createApplication(ownListing);
      const foreign = await createApplication(foreignListing);
      const waiting = await createApplication(ownListing, true);
      const call = (id: string, selectedWorkspace = workspace.id) => {
        const path = `/api/v1/provider/applications/${id}/conversation`;
        return operation === 'read'
          ? agent
              .get(`${path}/summary`)
              .set('x-workspace-id', selectedWorkspace)
          : agent
              .patch(`${path}/applicant-replies`)
              .set('x-workspace-id', selectedWorkspace)
              .send({ applicantRepliesEnabled: true });
      };
      await call(own.id).expect(200);
      const bodies: unknown[] = [];
      for (const id of [randomUUID(), foreign.id, waiting.id]) {
        const response = await call(id).expect(404);
        bodies.push(response.body as unknown);
      }
      await f.runtimeSql(workspaces[0].id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          workspaces[0].id,
        ]);
        await c.query(
          `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color)
            VALUES($1,$2,$3,'AGENT','#7C3AED')`,
          [randomUUID(), workspaces[0].id, userId],
        );
      });
      // The same application is now in the selected workspace but outside AGENT scope.
      const inaccessible = await call(foreign.id, workspaces[0].id).expect(404);
      bodies.push(inaccessible.body as unknown);
      expect(bodies).toEqual(
        Array.from({ length: 4 }, () => ({
          statusCode: 404,
          error: 'Not Found',
          message: 'Application not found',
        })),
      );
      expect(
        await f.prisma.applicationConversation.count({
          where: { applicationId: { in: [foreign.id, waiting.id] } },
        }),
      ).toBe(0);
    },
  );
  it('profile edits atomically revalidate both workspaces and preserve waiting queue order', async () => {
    const agent = request.agent(
      app.getHttpServer() as Parameters<typeof request>[0],
    );
    const registered = await agent
      .post('/api/v1/auth/register')
      .send({
        name: 'Cross workspace applicant',
        email: `${randomUUID()}@runtime.test`,
        password: 'StrongPass123',
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const userId = (registered.body as { id: string }).id;
    await agent
      .patch('/api/v1/applicant/profile')
      .send({
        introduction: 'Cross workspace profile revalidation.',
        householdNetIncome: 3000,
      })
      .expect(200);
    const activeIds: string[] = [],
      waitingIds: string[] = [];
    const queue: bigint[] = [];
    for (const workspace of workspaces) {
      const listingId = await f.listing(workspace.id, workspace.owner);
      await f.applicationSql(workspace.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          workspace.id,
        ]);
        await c.query(
          `UPDATE listings SET status='published',published_at=clock_timestamp(),minimum_household_net_income=2500 WHERE id=$1`,
          [listingId],
        );
      });
      const active = await f.prisma.application.create({
        data: {
          listingId,
          applicantId: userId,
          status: 'ACTIVE',
          activeAt: new Date(),
        },
      });
      activeIds.push(active.id);
      const other = await f.user();
      await f.prisma.applicantProfile.create({
        data: {
          applicantId: other,
          introduction: 'Eligible waiting applicant',
          householdNetIncome: 5000,
        },
      });
      const waiting = await f.prisma.application.create({
        data: { listingId, applicantId: other, status: 'WAITING' },
      });
      waitingIds.push(waiting.id);
      queue.push(waiting.queueOrder);
    }
    await agent
      .patch('/api/v1/applicant/profile')
      .send({ householdNetIncome: 1000 })
      .expect(200);
    const rejected = await f.prisma.application.findMany({
      where: { id: { in: activeIds } },
    });
    expect(rejected).toHaveLength(2);
    expect(
      rejected.every(
        (row) =>
          row.status === 'REJECTED' &&
          row.publicReason === 'PROFILE_NO_LONGER_ELIGIBLE',
      ),
    ).toBe(true);
    for (const [index, id] of waitingIds.entries())
      expect(
        await f.prisma.application.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'ACTIVE', queueOrder: queue[index] });
    await agent.get('/api/v1/applicant/applications/overview').expect(200);
    expect(
      (
        await f.prisma.applicantProfile.findUniqueOrThrow({
          where: { applicantId: userId },
        })
      ).householdNetIncome,
    ).toBe(1000);
  });
  it('keeps public creation closed while structural creation commits provenance, assignment and criteria together', async () => {
    const agent = request.agent(
      app.getHttpServer() as Parameters<typeof request>[0],
    );
    const registered = await agent
      .post('/api/v1/auth/register')
      .send({
        name: 'Workspace provider',
        email: `${randomUUID()}@runtime.test`,
        password: 'StrongPass123',
        role: 'provider',
        providerType: 'private',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const userId = (registered.body as { id: string }).id;
    const workspace = await f.workspaceFor(userId);
    const actor = {
      authority: await f.session(userId),
      workspaceId: workspace.id,
    };
    await agent
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', workspace.id)
      .send({ city: 'Berlin' })
      .expect(503);
    expect(
      await f.prisma.listing.count({ where: { workspaceId: workspace.id } }),
    ).toBe(0);
    let eligibilityCalls = 0;
    const created = await app
      .get(ListingCreation)
      .run(actor, { city: 'Berlin', coldRent: 1234.56 }, randomUUID(), () => {
        eligibilityCalls++;
        return Promise.resolve();
      });
    expect(eligibilityCalls).toBe(1);
    expect(created).toMatchObject({
      workspaceId: workspace.id,
      createdByMembershipId: workspace.owner,
      responsibleMembershipId: workspace.owner,
      revision: 1,
      displayOrder: 1,
      deposit: 2469.12,
    });
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { listingId: created.id, sequence: 1, reason: 'INITIAL' },
      }),
    ).toBe(1);
    expect(
      await f.prisma.listingCriteriaRevision.count({
        where: { listingId: created.id, source: 'NATIVE' },
      }),
    ).toBe(1);
    await expect(
      app
        .get(ListingCreation)
        .run(actor, { city: 'Berlin' }, randomUUID(), () =>
          Promise.reject(new Error('Entitlement denied')),
        ),
    ).rejects.toThrow('Entitlement denied');
    expect(
      await f.prisma.listing.count({ where: { workspaceId: workspace.id } }),
    ).toBe(1);
  });
  it('retirement compacts active positions transactionally without erasing historical assignment', async () => {
    const workspace = workspaces[0];
    const actor = {
      authority: await f.session(workspace.ownerUser),
      workspaceId: workspace.id,
    };
    const ids = [
      await f.listing(workspace.id, workspace.owner),
      await f.listing(workspace.id, workspace.owner),
      await f.listing(workspace.id, workspace.owner),
    ];
    await app.get(ListingsService).retire(ids[1], actor);
    const retired = await f.prisma.listing.findUniqueOrThrow({
      where: { id: ids[1] },
    });
    expect(retired).toMatchObject({
      status: 'RETIRED',
      displayOrder: null,
      responsibleMembershipId: workspace.owner,
    });
    const active = await f.prisma.listing.findMany({
      where: { workspaceId: workspace.id, status: { not: 'RETIRED' } },
      orderBy: { displayOrder: 'asc' },
      select: { displayOrder: true },
    });
    expect(active.map((row) => row.displayOrder)).toEqual(
      active.map((_row, index) => index + 1),
    );
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { listingId: retired.id },
      }),
    ).toBe(1);
  });
});
