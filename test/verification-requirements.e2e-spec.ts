import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { VerificationRequirementService } from '../src/application-documents/verification-requirement.service';
import { VerificationSubjectService } from '../src/application-documents/verification-subject.service';
import { ApplicationDocumentActivityService } from '../src/application-documents/application-document-activity.service';
import { ApplicationDocumentFinalizationService } from '../src/application-documents/application-document-finalization.service';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

jest.setTimeout(20000);

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected response object');
  return value as Record<string, unknown>;
}

describe('Verification requirement domain (isolated PostgreSQL schema)', () => {
  const schema = `verify_${randomUUID().replaceAll('-', '')}`;
  const applicationName = schema;
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let agent: ReturnType<typeof request.agent>;
  let foreignAgent: ReturnType<typeof request.agent>;
  let providerId: string;
  let lifecycle: ApplicationLifecycleService;
  let created = false;
  let requirements: VerificationRequirementService;
  let subjects: VerificationSubjectService;
  let order = 0;

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url) throw new Error('Dedicated E2E database required');
    assertSafeE2EDatabaseUrl(url);
    process.env['DATABASE_URL'] = url;
    process.env['NODE_ENV'] = 'test';
    process.env['SESSION_SECRET'] =
      'deposit-test-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';
    process.env['OUTBOX_DISPATCH_ENABLED'] = 'false';
    process.env['REALTIME_ENABLED'] = 'false';
    process.env['VIEWING_EXPIRY_ENABLED'] = 'false';
    admin = new Pool({ connectionString: url, max: 1 });
    const setup = await admin.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await setup.query(`SET search_path TO "${schema}"`);
      const root = resolve(process.cwd(), 'prisma/migrations');
      for (const name of readdirSync(root).sort()) {
        if (name === 'migration_lock.toml') continue;
        await setup.query(
          readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
        );
      }
    } finally {
      setup.release();
    }
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      application_name: applicationName,
      max: 8,
    });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await prisma.$connect();
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({ ...process.env, DATABASE_URL: scoped.href }),
      )
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    // Grants require real persisted session rows in this suite's isolated schema.
    app.use(app.get(SessionInfrastructureService).createMiddleware());
    app.use(passport.initialize());
    app.use(passport.session());
    await app.init();
    requirements = app.get(VerificationRequirementService);
    subjects = app.get(VerificationSubjectService);
    lifecycle = app.get(ApplicationLifecycleService);
    const server: unknown = app.getHttpServer();
    if (!server || typeof server !== 'object')
      throw new Error('HTTP server required');
    agent = request.agent(server as Parameters<typeof request>[0]);
    foreignAgent = request.agent(server as Parameters<typeof request>[0]);
    async function register(target: typeof agent) {
      return target
        .post('/api/v1/auth/register')
        .send({
          name: 'Deposit provider',
          email: `${randomUUID()}@verify.test`,
          password: 'StrongPass123',
          role: 'provider',
          providerType: 'private',
          acceptedTerms: true,
          acceptedPrivacy: true,
        })
        .expect(201);
    }
    providerId = String(body(await register(agent))['id']);
    await register(foreignAgent);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pool?.end();
    if (admin && created) {
      if (!/^verify_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      // Only this suite's newly created schema is removed; public/dev data is untouched.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  type Runner = (
    operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ) => Promise<unknown>;

  function holdFirstListingLock(id: string) {
    const run = prisma.$transaction.bind(prisma) as Runner;
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(
        (operation: Parameters<Runner>[0], options?: Parameters<Runner>[1]) =>
          run(
            (tx) =>
              operation(
                new Proxy(tx, {
                  get(target, property) {
                    if (property === '$queryRaw')
                      return async (
                        sql: TemplateStringsArray | Prisma.Sql,
                        ...values: unknown[]
                      ) => {
                        if (!values.includes(id))
                          return target.$queryRaw(sql, ...values);
                        const attempt = ++attempts;
                        const result = await target.$queryRaw(sql, ...values);
                        if (attempt === 1) {
                          acquired();
                          await gate;
                        }
                        return result;
                      };
                    const value: unknown = Reflect.get(target, property);
                    return value;
                  },
                }),
              ),
            options,
          ),
      );
    return {
      locked,
      release,
      spy,
      attempts: () => attempts,
      async waitForDatabaseWaiter() {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const result = await admin.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%listings%'",
            [applicationName],
          );
          if (result.rows[0].n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          'Competing operation did not wait on the PostgreSQL row lock',
        );
      },
    };
  }

  async function fixture() {
    const listing = await prisma.listing.create({
      data: {
        providerId,
        displayOrder: ++order,
        status: 'PUBLISHED',
        title: 'Verification fixture',
      },
    });
    const user = await prisma.user.create({
      data: {
        name: 'Applicant',
        email: `${randomUUID()}@verify.test`,
        passwordHash: 'unused',
        acceptedTermsAt: new Date(),
        acceptedPrivacyAt: new Date(),
      },
    });
    const application = await prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: user.id,
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    return { listing, user, application };
  }
  const requestCommand = (type: 'SCHUFA' | 'INCOME_PROOF' = 'SCHUFA') => ({
    operation: 'REQUEST' as const,
    items: [{ type }],
  });
  async function row(id: string) {
    return prisma.applicationDocumentRequest.findUniqueOrThrow({
      where: { id },
    });
  }
  async function scope(id: string) {
    return (await prisma.application.findUniqueOrThrow({ where: { id } }))
      .verificationScopeRevision;
  }
  async function evidence(
    requestId: string,
    state: 'PROCESSING' | 'AVAILABLE' = 'AVAILABLE',
  ) {
    const file = await prisma.applicationDocumentFile.create({
      data: {
        requestId,
        storageKey: `documents/${randomUUID()}/${randomUUID()}`,
        bucket: 'domain-fixture',
        checksum: 'a'.repeat(64),
        mimeType: 'application/pdf',
        size: 100,
        state,
        versionId: randomUUID(),
        etag: 'etag',
        recoverAfter: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 120000),
        availableAt: state === 'AVAILABLE' ? new Date() : null,
        reviewedAt: state === 'AVAILABLE' ? new Date() : null,
      },
    });
    await prisma.applicationDocumentRequest.update({
      where: { id: requestId },
      data: { currentFileId: file.id },
    });
    return file;
  }
  it('supports independent same-type subjects, additional scope, actor attribution and natural subject identity', async () => {
    const f = await fixture(),
      key = randomUUID();
    const member = await subjects.householdMember(
      f.application.id,
      providerId,
      key,
      'Member B',
    );
    expect(
      await subjects.householdMember(
        f.application.id,
        providerId,
        key,
        'Member B',
      ),
    ).toEqual(member);
    await expect(
      subjects.householdMember(
        f.application.id,
        providerId,
        key,
        'Changed label',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await scope(f.application.id)).toBe(0);
    const result = await requirements.execute(
      f.application.id,
      providerId,
      {
        operation: 'REQUEST',
        items: [
          { type: 'INCOME_PROOF' },
          { type: 'INCOME_PROOF', subjectId: member.id },
          { type: 'SCHUFA' },
        ],
      },
      randomUUID(),
    );
    expect(result.scopeRevision).toBe(1);
    expect(result.requirements).toHaveLength(3);
    const rows = await prisma.applicationDocumentRequest.findMany({
      where: { applicationId: f.application.id },
    });
    expect(
      new Set(
        rows.filter((r) => r.type === 'INCOME_PROOF').map((r) => r.subjectId),
      ).size,
    ).toBe(2);
    expect(
      rows.every(
        (r) =>
          r.createdByUserId === providerId &&
          r.createdScopeRevision === 1 &&
          r.provenance === 'NATIVE',
      ),
    ).toBe(true);
    await expect(
      requirements.execute(
        f.application.id,
        providerId,
        requestCommand('INCOME_PROOF'),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await scope(f.application.id)).toBe(1);
    expect(
      (
        await requirements.execute(f.application.id, providerId, {
          operation: 'REQUEST',
          items: [{ type: 'IDENTITY_DOCUMENT' }],
        })
      ).scopeRevision,
    ).toBe(2);
    const activity = await prisma.applicationActivity.findMany({
      where: { applicationId: f.application.id, type: 'DOCUMENT_REQUESTED' },
    });
    expect(activity).toHaveLength(4);
    expect(activity.every((r) => r.actorUserId === providerId)).toBe(true);
  });
  it('replays canonical batches durably, rejects key reuse, checks authorization and replays after freeze', async () => {
    const f = await fixture(),
      key = randomUUID();
    const command = {
      operation: 'REQUEST' as const,
      items: [{ type: 'SCHUFA' as const }, { type: 'INCOME_PROOF' as const }],
    };
    const result = await requirements.execute(
      f.application.id,
      providerId,
      command,
      key,
    );
    expect(
      await requirements.execute(
        f.application.id,
        providerId,
        { ...command, items: [...command.items].reverse() },
        key,
      ),
    ).toEqual(result);
    await expect(
      requirements.execute(f.application.id, providerId, requestCommand(), key),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      requirements.execute(
        f.application.id,
        providerId,
        { operation: 'CANCEL', requestId: result.requirements[0].id },
        key,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const foreign = String(
      body(await foreignAgent.get('/api/v1/auth/me').expect(200))['id'],
    );
    await expect(
      requirements.execute(f.application.id, foreign, command, key),
    ).rejects.toMatchObject({ status: 404 });
    await lifecycle.withdraw(f.application.id, f.user.id);
    expect(
      await requirements.execute(f.application.id, providerId, command, key),
    ).toEqual(result);
    await expect(
      requirements.execute(
        f.application.id,
        providerId,
        { operation: 'CANCEL', requestId: result.requirements[0].id },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await scope(f.application.id)).toBe(1);
  });
  it('rolls scope, identities, requirements, activity and receipt back together', async () => {
    const f = await fixture(),
      key = randomUUID();
    const spy = jest
      .spyOn(app.get(ApplicationDocumentActivityService), 'append')
      .mockRejectedValueOnce(new Error('activity failure'));
    try {
      await expect(
        requirements.execute(
          f.application.id,
          providerId,
          requestCommand(),
          key,
        ),
      ).rejects.toThrow('activity failure');
    } finally {
      spy.mockRestore();
    }
    expect(await scope(f.application.id)).toBe(0);
    expect(
      await prisma.applicationDocumentRequest.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await prisma.applicationVerificationSubject.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await prisma.verificationCommandReceipt.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      (
        await requirements.execute(
          f.application.id,
          providerId,
          requestCommand(),
          key,
        )
      ).scopeRevision,
    ).toBe(1);
  });
  it('cancels received/reviewed evidence without rewriting it and links a later round without relabeling cancellation', async () => {
    const f = await fixture(),
      first = await requirements.execute(
        f.application.id,
        providerId,
        requestCommand(),
      ),
      id = first.requirements[0].id;
    const file = await evidence(id),
      key = randomUUID();
    const cancelled = await requirements.execute(
      f.application.id,
      providerId,
      { operation: 'CANCEL', requestId: id, expectedRevision: 1 },
      key,
    );
    expect(cancelled.scopeRevision).toBe(2);
    expect((await row(id)).closedAt).toBeInstanceOf(Date);
    expect(await row(id)).toMatchObject({
      lifecycleState: 'CANCELLED',
      supersededAt: null,
      closedByUserId: providerId,
      revision: 2,
    });
    expect(
      await prisma.applicationDocumentFile.findUniqueOrThrow({
        where: { id: file.id },
      }),
    ).toEqual(file);
    expect(
      await requirements.execute(
        f.application.id,
        providerId,
        { operation: 'CANCEL', requestId: id, expectedRevision: 1 },
        key,
      ),
    ).toEqual(cancelled);
    const next = await requirements.execute(
      f.application.id,
      providerId,
      requestCommand(),
    );
    expect(await row(next.requirements[0].id)).toMatchObject({
      round: 2,
      predecessorId: id,
      lifecycleState: 'OPEN',
      createdScopeRevision: 3,
    });
    expect((await row(id)).lifecycleState).toBe('CANCELLED');
  });
  it('closes a processing requirement and ignores late clean finalization', async () => {
    const f = await fixture(),
      first = await requirements.execute(
        f.application.id,
        providerId,
        requestCommand(),
      ),
      id = first.requirements[0].id;
    const file = await evidence(id, 'PROCESSING');
    await requirements.execute(f.application.id, providerId, {
      operation: 'CANCEL',
      requestId: id,
    });
    await app.get(ApplicationDocumentFinalizationService).process({
      bucket: file.bucket,
      key: file.storageKey,
      versionId: file.versionId!,
      etag: file.etag!,
      occurredAt: new Date(),
      verdict: 'COMPLETED/NO_THREATS_FOUND',
      clean: true,
    });
    expect(
      await prisma.applicationDocumentFile.findUniqueOrThrow({
        where: { id: file.id },
      }),
    ).toMatchObject({
      state: 'FAILED',
      failureReason: 'REQUIREMENT_CANCELLED',
      versionId: file.versionId,
      checksum: file.checksum,
    });
    expect((await row(id)).lifecycleState).toBe('CANCELLED');
    expect(await scope(f.application.id)).toBe(2);
    expect(
      await prisma.applicationActivity.count({
        where: { applicationId: f.application.id, type: 'DOCUMENT_UPLOADED' },
      }),
    ).toBe(0);
  });
  it('supersedes atomically with one successor and preserves original evidence', async () => {
    const f = await fixture(),
      first = await requirements.execute(
        f.application.id,
        providerId,
        requestCommand(),
      ),
      id = first.requirements[0].id,
      file = await evidence(id);
    const results = await Promise.allSettled([
      requirements.execute(
        f.application.id,
        providerId,
        { operation: 'REPLACE', requestId: id },
        randomUUID(),
      ),
      requirements.execute(
        f.application.id,
        providerId,
        { operation: 'REPLACE', requestId: id },
        randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const old = await row(id);
    expect(old.lifecycleState).toBe('SUPERSEDED');
    expect(old.closedAt).toEqual(old.supersededAt);
    const successor = await prisma.applicationDocumentRequest.findFirstOrThrow({
      where: { predecessorId: id },
    });
    expect(successor).toMatchObject({
      round: 2,
      createdScopeRevision: 2,
      lifecycleState: 'OPEN',
    });
    expect(old.closedScopeRevision).toBe(2);
    expect(
      await prisma.applicationDocumentFile.findUniqueOrThrow({
        where: { id: file.id },
      }),
    ).toEqual(file);
    expect(await scope(f.application.id)).toBe(2);
  });
  it('serializes distinct requests and duplicate retries across PostgreSQL transactions', async () => {
    const f = await fixture(),
      key = randomUUID();
    const duplicate = await Promise.all(
      Array.from({ length: 3 }, () =>
        requirements.execute(
          f.application.id,
          providerId,
          requestCommand(),
          key,
        ),
      ),
    );
    for (const result of duplicate) expect(result).toEqual(duplicate[0]);
    expect(await scope(f.application.id)).toBe(1);
    const later = await Promise.all([
      requirements.execute(
        f.application.id,
        providerId,
        requestCommand('INCOME_PROOF'),
        randomUUID(),
      ),
      requirements.execute(
        f.application.id,
        providerId,
        { operation: 'CANCEL', requestId: duplicate[0].requirements[0].id },
        randomUUID(),
      ),
    ]);
    expect(later.map((r) => r.scopeRevision).sort()).toEqual([2, 3]);
    expect(
      await prisma.verificationCommandReceipt.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(3);
  });
  it.each([true, false])(
    'serializes terminal transition versus requirement creation, terminalFirst=%s',
    async (terminalFirst) => {
      const f = await fixture(),
        gate = holdFirstListingLock(f.listing.id);
      let first: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined;
      const outcomes: PromiseSettledResult<unknown>[] = [];
      const observe = (promise: Promise<unknown>) =>
        promise.then(
          (value) => {
            outcomes.push({ status: 'fulfilled', value });
          },
          (reason: unknown) => {
            outcomes.push({ status: 'rejected', reason });
          },
        );
      try {
        first = observe(
          terminalFirst
            ? lifecycle.withdraw(f.application.id, f.user.id)
            : requirements.execute(
                f.application.id,
                providerId,
                requestCommand(),
              ),
        );
        await gate.locked;
        second = observe(
          terminalFirst
            ? requirements.execute(
                f.application.id,
                providerId,
                requestCommand(),
              )
            : lifecycle.withdraw(f.application.id, f.user.id),
        );
        await gate.waitForDatabaseWaiter();
        gate.release();
        await Promise.all([first, second]);
        expect(
          (
            await prisma.application.findUniqueOrThrow({
              where: { id: f.application.id },
            })
          ).status,
        ).toBe('WITHDRAWN');
        expect(
          await prisma.applicationDocumentRequest.count({
            where: { applicationId: f.application.id, lifecycleState: 'OPEN' },
          }),
        ).toBe(terminalFirst ? 0 : 1);
        expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(
          terminalFirst ? 1 : 0,
        );
      } finally {
        gate.release();
        await Promise.allSettled([first, second]);
        gate.spy.mockRestore();
      }
    },
  );
  it('database protects subject membership, current-file identity, immutable records and scope completeness', async () => {
    const a = await fixture(),
      b = await fixture();
    const one = await requirements.execute(
        a.application.id,
        providerId,
        requestCommand(),
        randomUUID(),
      ),
      two = await requirements.execute(
        b.application.id,
        providerId,
        requestCommand(),
      );
    const first = await row(one.requirements[0].id),
      other = await row(two.requirements[0].id),
      file = await evidence(other.id);
    await expect(
      requirements.execute(a.application.id, providerId, {
        operation: 'REQUEST',
        items: [{ type: 'INCOME_PROOF', subjectId: other.subjectId }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prisma.applicationDocumentRequest.update({
        where: { id: first.id },
        data: { currentFileId: file.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.applicationDocumentRequest.update({
        where: { id: first.id },
        data: { definitionKey: 'changed' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.applicationVerificationSubject.update({
        where: { id: first.subjectId },
        data: { displayLabel: 'changed' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.application.update({
        where: { id: a.application.id },
        data: { verificationScopeRevision: { increment: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.application.update({
        where: { id: a.application.id },
        data: { verificationScopeRevision: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.verificationCommandReceipt.deleteMany({
        where: { applicationId: a.application.id },
      }),
    ).rejects.toThrow();
    await requirements.execute(a.application.id, providerId, {
      operation: 'CANCEL',
      requestId: first.id,
    });
    await expect(
      prisma.applicationDocumentRequest.update({
        where: { id: first.id },
        data: { currentFileId: null },
      }),
    ).rejects.toThrow();
  });
});
