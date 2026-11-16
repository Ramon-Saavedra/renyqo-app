import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { installE2eSessionMiddleware } from './e2e-session-middleware';
import * as defaults from '../src/provider-authorization/capabilities/provider-default-capabilities';
import type { ProviderCapability } from '../src/provider-authorization/capabilities/provider-capability';

export class CapabilityFixture {
  readonly db = new ListingWorkspaceFixture();
  readonly workspaces: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[] = [];
  app!: INestApplication;
  async start(count: number) {
    await this.db.start();
    const passwordHash = await bcrypt.hash('StrongPass123', 12);
    for (let i = 0; i < count; i++) {
      const w = await this.db.organization();
      this.workspaces.push(w);
      await this.db.prisma.user.updateMany({
        where: { id: { in: [w.ownerUser, ...w.agents.map((m) => m.userId)] } },
        data: { passwordHash },
      });
    }
    await this.db.activateApplication();
    process.env['SESSION_SECRET'] =
      'capability-http-secret-at-least-thirty-two-characters';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(
        prismaServiceWithSharedPool(
          this.db.applicationRuntime,
          this.db.applicationPool,
          this.db.schema,
        ),
      )
      .compile();
    this.app = module.createNestApplication();
    this.app.setGlobalPrefix('api/v1');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    installE2eSessionMiddleware(this.app);
    await this.app.init();
  }
  async seed(index: number) {
    const w = this.workspaces[index];
    const listingId = await this.db.listing(w.id, w.owner, w.agents[0].id);
    await this.db.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        "UPDATE listings SET status='published',published_at=clock_timestamp() WHERE id=$1",
        [listingId],
      );
    });
    const application = await this.db.prisma.application.create({
      data: {
        listingId,
        applicantId: await this.db.user(),
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    return { ...w, listingId, applicationId: application.id };
  }
  async login(userId: string) {
    const user = await this.db.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const client = request.agent(
      this.app.getHttpServer() as Parameters<typeof request>[0],
    );
    await client
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'StrongPass123' })
      .expect(200);
    return client;
  }
  // Test-only future policy availability. Authentication, tenant scope, membership
  // reads, RLS, locks and command/domain checks still use real PostgreSQL.
  restrictAgents(available: readonly ProviderCapability[]) {
    const original = defaults.providerDefaultCapabilities;
    return jest
      .spyOn(defaults, 'providerDefaultCapabilities')
      .mockImplementation((member) =>
        member.role === 'AGENT' && member.status === 'ACTIVE'
          ? new Set(available)
          : original(member),
      );
  }
  async stop() {
    try {
      await this.app?.close();
    } finally {
      await this.db.stop();
    }
  }
}
