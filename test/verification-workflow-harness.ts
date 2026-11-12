import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ValidationPipe,
  StreamableFile,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import passport from 'passport';
import request, { type Response } from 'supertest';
import type { Application } from 'express';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';
import { ApplicationDocumentStorageService } from '../src/application-documents/application-document-storage.service';
import { ApplicationDocumentFinalizationService } from '../src/application-documents/application-document-finalization.service';
import { configureCsrfProtection } from '../src/security/csrf/csrf-protection';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';
import { eligibleProfileFields } from './eligible-applicant-fixture';
import { createPublishedListingForProvider } from './e2e-workspace-listing';
import { bindProviderWorkspaceHeader } from './e2e-provider-context';

export function responseObject(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}

export type WorkflowActor = {
  id: string;
  agent: ReturnType<typeof request.agent>;
};
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF',
);

/** Real auth/session/CSRF/PostgreSQL; only AWS transport is substituted. */
export class VerificationWorkflowHarness {
  readonly schema = `verification_http_${randomUUID().replaceAll('-', '')}`;
  app!: INestApplication;
  prisma!: PrismaClient;
  provider!: WorkflowActor;
  foreignProvider!: WorkflowActor;
  applicant!: WorkflowActor;
  otherApplicant!: WorkflowActor;
  private admin!: Pool;
  private pool!: Pool;
  private created = false;
  private displayOrder = 0;
  private envSnapshot: NodeJS.ProcessEnv | undefined;

  async start() {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url) throw new Error('Dedicated E2E database required');
    assertSafeE2EDatabaseUrl(url);
    this.envSnapshot = {
      DATABASE_URL: process.env['DATABASE_URL'],
      SESSION_SECRET: process.env['SESSION_SECRET'],
      FRONTEND_URL: process.env['FRONTEND_URL'],
      OUTBOX_DISPATCH_ENABLED: process.env['OUTBOX_DISPATCH_ENABLED'],
      REALTIME_ENABLED: process.env['REALTIME_ENABLED'],
      VIEWING_EXPIRY_ENABLED: process.env['VIEWING_EXPIRY_ENABLED'],
      DOCUMENTS_S3_BUCKET: process.env['DOCUMENTS_S3_BUCKET'],
      DOCUMENTS_AWS_ACCOUNT_ID: process.env['DOCUMENTS_AWS_ACCOUNT_ID'],
      DOCUMENTS_GUARDDUTY_PLAN_ARN: process.env['DOCUMENTS_GUARDDUTY_PLAN_ARN'],
    };
    Object.assign(process.env, {
      DATABASE_URL: url,
      NODE_ENV: 'test',
      FRONTEND_URL: 'http://localhost:3001',
      SESSION_SECRET: 'verification-http-secret-at-least-thirty-two-characters',
      OUTBOX_DISPATCH_ENABLED: 'false',
      REALTIME_ENABLED: 'false',
      VIEWING_EXPIRY_ENABLED: 'false',
      DOCUMENTS_S3_BUCKET: 'verification-http-e2e',
      DOCUMENTS_AWS_ACCOUNT_ID: '111122223333',
      DOCUMENTS_GUARDDUTY_PLAN_ARN:
        'arn:aws:guardduty:eu-central-1:111122223333:malware-protection-plan/test',
    });
    this.admin = new Pool({ connectionString: url, max: 1 });
    const client = await this.admin.connect();
    try {
      await client.query(`CREATE SCHEMA "${this.schema}"`);
      this.created = true;
      await client.query(`SET search_path TO "${this.schema}"`);
      const root = resolve('prisma/migrations');
      for (const name of readdirSync(root).sort()) {
        if (name === 'migration_lock.toml') continue;
        await client.query(
          readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
        );
      }
    } finally {
      client.release();
    }
    this.pool = new Pool({
      connectionString: url,
      options: `-c search_path=${this.schema}`,
      max: 8,
    });
    this.prisma = new PrismaClient({
      adapter: new PrismaPg(this.pool, { schema: this.schema }),
    });
    await this.prisma.$connect();
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${this.schema}`);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(
        prismaServiceWithSharedPool(this.prisma, this.pool, this.schema),
      )
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({ ...process.env, DATABASE_URL: scoped.href }),
      )
      .compile();
    this.app = module.createNestApplication();
    this.app.setGlobalPrefix('api/v1');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    this.app.use(this.app.get(SessionInfrastructureService).createMiddleware());
    this.app.use(passport.initialize());
    this.app.use(passport.session());
    configureCsrfProtection(
      this.app.getHttpAdapter().getInstance() as Application,
      'http://localhost:3001',
    );
    await this.app.init();
    const storage = this.app.get(ApplicationDocumentStorageService);
    jest
      .spyOn(storage, 'put')
      .mockImplementation((file) =>
        Promise.resolve({ versionId: `version-${file.id}`, etag: 'test-etag' }),
      );
    jest.spyOn(storage, 'evidence').mockResolvedValue('CLEAN');
    jest
      .spyOn(storage, 'download')
      .mockImplementation(() => Promise.resolve(new StreamableFile(pdf)));
    this.provider = await this.register('provider');
    this.foreignProvider = await this.register('provider');
    this.applicant = await this.register('applicant');
    this.otherApplicant = await this.register('applicant');
  }

  async stop() {
    await this.app?.close();
    await this.prisma?.$disconnect();
    await this.pool?.end();
    if (this.admin) {
      if (this.created) {
        if (!/^verification_http_[a-f0-9]{32}$/.test(this.schema))
          throw new Error('Unsafe schema');
        await this.admin.query(`DROP SCHEMA "${this.schema}" CASCADE`);
      }
      await this.admin.end();
    }
    if (this.envSnapshot) {
      for (const [key, value] of Object.entries(this.envSnapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      this.envSnapshot = undefined;
    }
    jest.restoreAllMocks();
  }

  private async register(
    role: 'applicant' | 'provider',
  ): Promise<WorkflowActor> {
    const server: unknown = this.app.getHttpServer();
    const agent = request.agent(server as Parameters<typeof request>[0]);
    const actor = { id: '', agent };
    const response = await this.send(
      actor,
      'post',
      '/api/v1/auth/register',
      {
        name: 'Workflow actor',
        email: `${randomUUID()}@verification.test`,
        password: 'StrongPass123',
        role,
        ...(role === 'provider' ? { providerType: 'private' } : {}),
        acceptedTerms: true,
        acceptedPrivacy: true,
      },
      201,
    );
    actor.id = String(responseObject(response)['id']);
    if (role === 'provider') {
      await bindProviderWorkspaceHeader(this.prisma, actor.id, actor.agent);
    }
    if (role === 'applicant')
      await this.send(
        actor,
        'patch',
        '/api/v1/applicant/profile',
        eligibleProfileFields,
      );
    return actor;
  }

  async headers(actor: WorkflowActor) {
    const response = await actor.agent
      .get('/api/v1/auth/csrf-token')
      .expect(200);
    return {
      Origin: 'http://localhost:3001',
      'x-csrf-token': String(responseObject(response)['csrfToken']),
    };
  }

  async send(
    actor: WorkflowActor,
    method: 'post' | 'put' | 'patch',
    path: string,
    payload: object,
    status = 200,
    key?: string,
  ) {
    const headers = await this.headers(actor);
    const call = actor.agent[method](path).set(headers);
    if (key !== undefined) call.set('Idempotency-Key', key);
    return call.send(payload).expect(status);
  }

  async fixture(actor = this.applicant) {
    const listing = await createPublishedListingForProvider(
      this.prisma,
      this.provider.id,
      {
        title: 'Phase 3 fixture',
        displayOrder: ++this.displayOrder,
      },
    );
    const application = await this.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: actor.id,
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    return { listing, application };
  }

  async upload(applicationId: string, requestId: string, status = 201) {
    const headers = await this.headers(this.applicant);
    return this.applicant.agent
      .post(
        `/api/v1/applicant/applications/${applicationId}/document-requests/${requestId}/document`,
      )
      .set(headers)
      .attach('file', pdf, {
        filename: 'private-file.pdf',
        contentType: 'application/pdf',
      })
      .expect(status);
  }

  async finalize(documentId: string) {
    const file = await this.prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: documentId },
    });
    await this.app.get(ApplicationDocumentFinalizationService).process({
      bucket: file.bucket,
      key: file.storageKey,
      versionId: file.versionId!,
      etag: file.etag!,
      occurredAt: new Date(),
      verdict: 'COMPLETED/NO_THREATS_FOUND',
      clean: true,
    });
  }
}
