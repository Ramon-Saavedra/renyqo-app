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
import { ListingsService } from '../src/listings/listings.service';
import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ApplicationEligibilityAssessmentService } from '../src/eligibility/application-eligibility-assessment.service';
import { EligibilityService } from '../src/eligibility/eligibility.service';
import type { CreateListingDto } from '../src/listings/dto/create-listing.dto';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

jest.setTimeout(20000);

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected response object');
  return value as Record<string, unknown>;
}

describe('Profile prequalification assessments (isolated PostgreSQL schema)', () => {
  const schema = `prequal_${randomUUID().replaceAll('-', '')}`;
  const applicationName = schema;
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let service: ListingsService;
  let agent: ReturnType<typeof request.agent>;
  let foreignAgent: ReturnType<typeof request.agent>;
  let providerId: string;
  let lifecycle: ApplicationLifecycleService;
  let assessments: ApplicationEligibilityAssessmentService;
  let created = false;

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
    service = app.get(ListingsService);
    lifecycle = app.get(ApplicationLifecycleService);
    assessments = app.get(ApplicationEligibilityAssessmentService);
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
          email: `${randomUUID()}@prequal.test`,
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
      if (!/^prequal_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      // Only this suite's newly created schema is removed; public/dev data is untouched.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function listing(criteria: Partial<CreateListingDto> = {}) {
    const row = await service.create(providerId, {
      title: 'Prequalification',
      city: 'Berlin',
      street: 'Teststr. 1',
      zip: '10115',
      livingArea: 60,
      rooms: 2,
      bedrooms: 1,
      coldRent: 1000,
      availableFrom: '2027-01-01',
      ...criteria,
    });
    return service.publish(row.id, providerId);
  }
  async function applicant(facts: Record<string, unknown> = {}) {
    const target = request.agent(
      app.getHttpServer() as Parameters<typeof request>[0],
    );
    const response = await target
      .post('/api/v1/auth/register')
      .send({
        name: 'Applicant',
        email: `${randomUUID()}@prequal.test`,
        password: 'StrongPass123',
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const id = String(body(response)['id']);
    await target
      .patch('/api/v1/applicant/profile')
      .send({
        introduction: 'A normal applicant introduction.',
        householdNetIncome: 4000,
        adultsCount: 2,
        childrenCount: 0,
        hasPets: false,
        isSmoker: false,
        ...facts,
      })
      .expect(200);
    return { id, agent: target };
  }
  function history(applicationId: string) {
    return prisma.applicationEligibilityAssessment.findMany({
      where: { applicationId },
      orderBy: { revision: 'asc' },
      include: { checks: true },
    });
  }
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

  it('creates native typed revisions through HTTP and ignores non-criteria/no-op patches', async () => {
    const response = await agent
      .post('/api/v1/provider/listings')
      .send({ title: 'HTTP revision', minimumHouseholdNetIncome: 3000 })
      .expect(201);
    const id = String(body(response)['id']);
    await agent
      .patch(`/api/v1/provider/listings/${id}`)
      .send({ title: 'Other', minimumHouseholdNetIncome: 3000 })
      .expect(200);
    const revisions = await prisma.listingCriteriaRevision.findMany({
      where: { listingId: id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      source: 'NATIVE',
      actorUserId: providerId,
      minimumHouseholdNetIncome: 3000,
    });
  });
  it('atomically records admission; criteria mismatch preserves initial assessment, status and viewing state', async () => {
    const row = await listing({
      minimumHouseholdNetIncome: 4000,
      suitableForPeopleCount: 2,
      schufaRequired: true,
      incomeProofRequired: true,
    });
    const user = await applicant({
      schufaAvailable: false,
      incomeProofAvailable: false,
    });
    const applied = await user.agent
      .post(`/api/v1/listings/${row.id}/apply`)
      .expect(201);
    const id = String(body(applied)['id']);
    const [initial] = await history(id);
    expect(initial).toMatchObject({
      result: 'MATCH_WITH_OBSERVATIONS',
      trigger: 'APPLICATION_CREATED',
      householdNetIncome: 4000,
      householdSize: 2,
      schufaAvailable: false,
    });
    expect(initial.checks).toHaveLength(7);
    expect(
      await prisma.applicationActivity.count({
        where: { applicationId: id, type: 'APPLICATION_SUBMITTED' },
      }),
    ).toBe(1);
    const before = await prisma.application.findUniqueOrThrow({
      where: { id },
    });
    const invited = body(
      await agent
        .post(
          `/api/v1/provider/applications/${id}/viewing-workflow/invitations`,
        )
        .send({
          requestKey: randomUUID(),
          expectedWorkflowRevision: 0,
          startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          endsAt: new Date(Date.now() + 7 * 86400000 + 3600000).toISOString(),
          timeZone: 'Europe/Berlin',
        })
        .expect(200),
    );
    await user.agent
      .post(
        `/api/v1/applicant/applications/${id}/viewing-workflow/proposals/${String(invited['proposalId'])}/accept`,
      )
      .send({ requestKey: randomUUID(), expectedWorkflowRevision: 1 })
      .expect(200);
    const workflow = await prisma.viewingWorkflow.findUniqueOrThrow({
      where: { applicationId: id },
    });
    const appointment = await prisma.viewingAppointment.findFirstOrThrow({
      where: { workflowId: workflow.id },
      include: { viewing: true },
    });
    await agent
      .patch(`/api/v1/provider/listings/${row.id}`)
      .send({ minimumHouseholdNetIncome: 5000 })
      .expect(200);
    const rows = await history(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(initial);
    expect(rows[1]).toMatchObject({
      result: 'NO_MATCH',
      trigger: 'CRITERIA_CHANGED',
      revision: 2,
    });
    expect(rows[1].checks).toContainEqual({
      assessmentId: rows[1].id,
      criterion: 'INCOME',
      outcome: 'FAIL',
      code: 'household_income_below_requirement',
    });
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id } }),
    ).toEqual(before);
    expect(
      await prisma.viewingWorkflow.findUniqueOrThrow({
        where: { id: workflow.id },
      }),
    ).toEqual(workflow);
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: appointment.viewingId },
        include: { viewing: true },
      }),
    ).toEqual(appointment);
    const summary = body(
      await user.agent
        .get(`/api/v1/applicant/applications/${id}/profile-eligibility`)
        .expect(200),
    );
    expect(summary).toMatchObject({
      initial: { status: 'RECORDED', result: 'MATCH_WITH_OBSERVATIONS' },
      current: { result: 'NO_MATCH' },
      currentMismatch: true,
      currentAssessmentIsCurrent: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /householdNetIncome|criteriaRevisionId|checks|reason|5000/,
    );
    const other = await applicant();
    await other.agent
      .get(`/api/v1/applicant/applications/${id}/profile-eligibility`)
      .expect(404);
    await agent
      .get(`/api/v1/applicant/applications/${id}/profile-eligibility`)
      .expect(403);
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get(`/api/v1/applicant/applications/${id}/profile-eligibility`)
      .expect(401);
  });
  it('leaves legacy history UNKNOWN and reassesses WAITING without demotion or invented initial history', async () => {
    const row = await listing();
    const user = await applicant();
    const legacy = await prisma.application.create({
      data: { listingId: row.id, applicantId: user.id, status: 'WAITING' },
    });
    const path = `/api/v1/applicant/applications/${legacy.id}/profile-eligibility`;
    expect(body(await user.agent.get(path).expect(200))).toMatchObject({
      initial: { status: 'UNKNOWN' },
      current: { status: 'UNKNOWN' },
    });
    await service.update(row.id, providerId, { petsPolicy: 'NOT_ALLOWED' });
    expect(await history(legacy.id)).toHaveLength(1);
    expect(body(await user.agent.get(path).expect(200))).toMatchObject({
      initial: { status: 'UNKNOWN' },
      current: { status: 'RECORDED', result: 'MATCH' },
    });
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: legacy.id } }))
        .status,
    ).toBe('WAITING');
  });
  it('rolls application, activity and outbox back if assessment persistence fails', async () => {
    const row = await listing();
    const user = await applicant();
    const before = {
      activities: await prisma.applicationActivity.count(),
      outbox: await prisma.outboxEvent.count(),
    };
    const spy = jest
      .spyOn(assessments, 'record')
      .mockRejectedValueOnce(new Error('assessment failure'));
    try {
      await expect(lifecycle.apply(row.id, user.id)).rejects.toThrow(
        'assessment failure',
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.application.count({ where: { listingId: row.id } }),
    ).toBe(0);
    expect(await prisma.applicationActivity.count()).toBe(before.activities);
    expect(await prisma.outboxEvent.count()).toBe(before.outbox);
  });
  it('rolls criteria edits and revisions back if one reassessment fails', async () => {
    const row = await listing();
    const user = await applicant();
    const applied = await lifecycle.apply(row.id, user.id);
    const before = await history(applied.id);
    const spy = jest
      .spyOn(assessments, 'record')
      .mockRejectedValueOnce(new Error('reassessment failure'));
    try {
      await expect(
        service.update(row.id, providerId, { minimumHouseholdNetIncome: 9000 }),
      ).rejects.toThrow('reassessment failure');
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.listing.findUniqueOrThrow({
        where: { id: row.id },
        include: { images: true },
      }),
    ).toEqual(row);
    expect(
      await prisma.listingCriteriaRevision.count({
        where: { listingId: row.id },
      }),
    ).toBe(1);
    expect(await history(applied.id)).toEqual(before);
  });
  it('preserves profile-edit auto-rejection policy and records facts before rejection', async () => {
    const row = await listing({ minimumHouseholdNetIncome: 3000 });
    const user = await applicant();
    const applied = await lifecycle.apply(row.id, user.id);
    const initial = (await history(applied.id))[0];
    await user.agent
      .patch('/api/v1/applicant/profile')
      .send({ householdNetIncome: 2000 })
      .expect(200);
    const rows = await history(applied.id);
    expect(rows[0]).toEqual(initial);
    expect(rows[1]).toMatchObject({
      trigger: 'PROFILE_CHANGED',
      result: 'NO_MATCH',
      householdNetIncome: 2000,
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applied.id },
        })
      ).status,
    ).toBe('REJECTED');
  });
  it('matches SQL, endpoint, detail, admission and promotion semantics for missing facts and declarations', async () => {
    const rows = await Promise.all([
      listing(),
      listing({ minimumHouseholdNetIncome: 4000 }),
      listing({ petsPolicy: 'NOT_ALLOWED' }),
      listing({ smokingPolicy: 'NOT_ALLOWED' }),
      listing({ schufaRequired: true, incomeProofRequired: true }),
      listing({ petsPolicy: 'BY_ARRANGEMENT' }),
    ]);
    const user = await applicant({
      householdNetIncome: null,
      hasPets: null,
      isSmoker: null,
      schufaAvailable: false,
      incomeProofAvailable: null,
    });
    const profile = await prisma.applicantProfile.findUniqueOrThrow({
      where: { applicantId: user.id },
    });
    const evaluator = app.get(EligibilityService);
    const sql = await prisma.listing.findMany({
      where: {
        AND: [
          { id: { in: rows.map((r) => r.id) } },
          evaluator.buildHardMatchWhere(profile),
        ],
      },
    });
    expect(sql.map((r) => r.id).sort()).toEqual(
      rows
        .filter((r) => evaluator.evaluate(r, profile).canApply)
        .map((r) => r.id)
        .sort(),
    );
    for (const row of rows) {
      const evaluation = evaluator.evaluate(row, profile);
      expect(
        body(
          await user.agent
            .get(`/api/v1/listings/${row.id}/eligibility`)
            .expect(200),
        ),
      ).toMatchObject({
        canApply: evaluation.canApply,
        result: evaluation.result,
      });
      expect(
        body(await user.agent.get(`/api/v1/listings/${row.id}`).expect(200))[
          'profileMatch'
        ],
      ).toBe(
        evaluation.result === 'INSUFFICIENT_INFORMATION'
          ? 'PROFILE_INCOMPLETE'
          : evaluation.result,
      );
      if (evaluation.canApply)
        expect((await lifecycle.apply(row.id, user.id)).status).toBe('ACTIVE');
      else
        await expect(lifecycle.apply(row.id, user.id)).rejects.toMatchObject({
          status: 422,
        });
    }
    const waiting = await prisma.application.create({
      data: {
        listingId: rows[4].id,
        applicantId: (await applicant({ schufaAvailable: false })).id,
        status: 'WAITING',
      },
    });
    await service.pause(rows[4].id, providerId);
    await service.resume(rows[4].id, providerId);
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect((await history(waiting.id))[0]).toMatchObject({
      trigger: 'PROMOTION',
      result: 'MATCH_WITH_OBSERVATIONS',
    });
    const noProfile = await prisma.applicantProfile.delete({
      where: { applicantId: (await applicant()).id },
    });
    expect(
      await prisma.listing.count({
        where: evaluator.buildHardMatchWhere(null),
      }),
    ).toBe(0);
    expect(evaluator.evaluate(rows[0], null).canApply).toBe(false);
    expect(noProfile).toBeDefined();
  });
  it('database rejects mutation, incomplete checks, unrelated applications and stale criteria', async () => {
    const row = await listing();
    const user = await applicant();
    const applied = await lifecycle.apply(row.id, user.id);
    const [initial] = await history(applied.id);
    for (const table of [
      'listing_criteria_revisions',
      'application_eligibility_assessments',
      'application_eligibility_checks',
    ]) {
      await expect(
        pool.query(
          `UPDATE ${table} SET ${table === 'application_eligibility_checks' ? 'code=code' : 'revision=revision'}`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
        code: '23514',
      });
    }
    await expect(
      prisma.listingCriteriaRevision.create({
        data: {
          listingId: row.id,
          revision: 9,
          source: 'NATIVE',
          schufaRequired: false,
          incomeProofRequired: false,
        },
      }),
    ).rejects.toThrow();
    const data = { ...initial, checks: undefined, id: undefined };
    await expect(
      prisma.applicationEligibilityAssessment.create({
        data: {
          ...data,
          id: randomUUID(),
          revision: 2,
          trigger: 'PROFILE_CHANGED',
        },
      }),
    ).rejects.toThrow();
    const other = await listing();
    const otherCriteria = await prisma.listingCriteriaRevision.findFirstOrThrow(
      { where: { listingId: other.id } },
    );
    await expect(
      prisma.applicationEligibilityAssessment.create({
        data: {
          ...data,
          id: randomUUID(),
          revision: 2,
          trigger: 'PROFILE_CHANGED',
          listingId: other.id,
          criteriaRevisionId: otherCriteria.id,
          checks: {
            create: initial.checks.map((check) => ({
              criterion: check.criterion,
              outcome: check.outcome,
              code: check.code,
            })),
          },
        },
      }),
    ).rejects.toThrow();
    await service.update(row.id, providerId, { petsPolicy: 'BY_ARRANGEMENT' });
    await expect(
      prisma.applicationEligibilityAssessment.create({
        data: {
          ...data,
          id: randomUUID(),
          revision: 3,
          trigger: 'PROFILE_CHANGED',
          checks: {
            create: initial.checks.map((check) => ({
              criterion: check.criterion,
              outcome: check.outcome,
              code: check.code,
            })),
          },
        },
      }),
    ).rejects.toThrow();
  });
  it.each([false, true])(
    'serializes apply vs criteria edit, editFirst=%s',
    async (editFirst) => {
      const row = await listing({ minimumHouseholdNetIncome: 3000 });
      const user = await applicant();
      const gate = holdFirstListingLock(row.id);
      let first: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined;
      try {
        first = editFirst
          ? service.update(row.id, providerId, {
              minimumHouseholdNetIncome: 3500,
            })
          : lifecycle.apply(row.id, user.id);
        await gate.locked;
        second = editFirst
          ? lifecycle.apply(row.id, user.id)
          : service.update(row.id, providerId, {
              minimumHouseholdNetIncome: 3500,
            });
        await gate.waitForDatabaseWaiter();
        gate.release();
        await Promise.all([first, second]);
        const applied = await prisma.application.findFirstOrThrow({
          where: { listingId: row.id, applicantId: user.id },
        });
        const rows = await history(applied.id);
        const criteria = await prisma.listingCriteriaRevision.findMany({
          where: { listingId: row.id },
          orderBy: { revision: 'asc' },
        });
        expect(rows[0].criteriaRevisionId).toBe(criteria[editFirst ? 1 : 0].id);
        expect(rows.at(-1)?.criteriaRevisionId).toBe(criteria[1].id);
        expect(rows).toHaveLength(editFirst ? 1 : 2);
        expect(gate.attempts()).toBeGreaterThan(2);
      } finally {
        gate.release();
        await Promise.allSettled([first, second]);
        gate.spy.mockRestore();
      }
    },
  );
  it('serializes competing criteria edits with consecutive immutable revisions', async () => {
    const row = await listing();
    const user = await applicant();
    const applied = await lifecycle.apply(row.id, user.id);
    const gate = holdFirstListingLock(row.id);
    let first: Promise<unknown> | undefined,
      second: Promise<unknown> | undefined;
    try {
      first = service.update(row.id, providerId, {
        minimumHouseholdNetIncome: 3000,
      });
      await gate.locked;
      second = service.update(row.id, providerId, {
        petsPolicy: 'NOT_ALLOWED',
      });
      await gate.waitForDatabaseWaiter();
      gate.release();
      await Promise.all([first, second]);
      const rows = await prisma.listingCriteriaRevision.findMany({
        where: { listingId: row.id },
        orderBy: { revision: 'asc' },
      });
      expect(rows.map((r) => r.revision)).toEqual([1, 2, 3]);
      expect(rows[2]).toMatchObject({
        minimumHouseholdNetIncome: 3000,
        petsPolicy: 'NOT_ALLOWED',
      });
      expect((await history(applied.id)).map((r) => r.revision)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
      gate.spy.mockRestore();
    }
  });
  it.each([false, true])(
    'criteria becoming a mismatch vs admission, editFirst=%s',
    async (editFirst) => {
      const row = await listing({ minimumHouseholdNetIncome: 3000 });
      const user = await applicant();
      const gate = holdFirstListingLock(row.id);
      let first: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined;
      // Attach rejection handling immediately so the intentionally rejected submission is observed.
      const outcomes: PromiseSettledResult<unknown>[] = [];
      const observe = (operation: Promise<unknown>) =>
        operation.then(
          (value) => {
            outcomes.push({ status: 'fulfilled', value });
          },
          (reason: unknown) => {
            outcomes.push({ status: 'rejected', reason });
          },
        );
      try {
        first = observe(
          editFirst
            ? service.update(row.id, providerId, {
                minimumHouseholdNetIncome: 5000,
              })
            : lifecycle.apply(row.id, user.id),
        );
        await gate.locked;
        second = observe(
          editFirst
            ? lifecycle.apply(row.id, user.id)
            : service.update(row.id, providerId, {
                minimumHouseholdNetIncome: 5000,
              }),
        );
        await gate.waitForDatabaseWaiter();
        gate.release();
        await Promise.all([first, second]);
        const applied = await prisma.application.findFirst({
          where: { listingId: row.id, applicantId: user.id },
        });
        if (editFirst) {
          expect(applied).toBeNull();
          expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(
            1,
          );
        } else {
          if (!applied) throw new Error('Application missing');
          expect(applied.status).toBe('ACTIVE');
          expect((await history(applied.id)).map((r) => r.result)).toEqual([
            'MATCH',
            'NO_MATCH',
          ]);
          expect(outcomes.every((r) => r.status === 'fulfilled')).toBe(true);
        }
      } finally {
        gate.release();
        await Promise.allSettled([first, second]);
        gate.spy.mockRestore();
      }
    },
  );
  it('declaration edits remain observational and a terminal assessment is marked stale after later profile changes', async () => {
    const row = await listing({
      schufaRequired: true,
      minimumHouseholdNetIncome: 3000,
    });
    const user = await applicant({ schufaAvailable: true });
    const applied = await lifecycle.apply(row.id, user.id);
    const initial = (await history(applied.id))[0];
    await user.agent
      .patch('/api/v1/applicant/profile')
      .send({ schufaAvailable: false })
      .expect(200);
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applied.id },
        })
      ).status,
    ).toBe('ACTIVE');
    const rows = await history(applied.id);
    expect(rows[0]).toEqual(initial);
    expect(rows.at(-1)?.result).toBe('MATCH_WITH_OBSERVATIONS');
    await lifecycle.withdraw(applied.id, user.id);
    await user.agent
      .patch('/api/v1/applicant/profile')
      .send({ householdNetIncome: 2000 })
      .expect(200);
    const path = `/api/v1/applicant/applications/${applied.id}/profile-eligibility`;
    expect(body(await user.agent.get(path).expect(200))).toMatchObject({
      currentAssessmentIsCurrent: false,
      currentMismatch: null,
    });
  });
  it('an observed legacy criteria baseline is created now without inventing application-time history', async () => {
    const row = await prisma.listing.create({
      data: {
        providerId,
        displayOrder: 10000,
        status: 'PUBLISHED',
        title: 'Legacy',
      },
    });
    const user = await applicant();
    const legacy = await prisma.application.create({
      data: { listingId: row.id, applicantId: user.id, status: 'WAITING' },
    });
    await service.update(row.id, providerId, {
      minimumHouseholdNetIncome: 3000,
    });
    const revisions = await prisma.listingCriteriaRevision.findMany({
      where: { listingId: row.id },
      orderBy: { revision: 'asc' },
    });
    expect(revisions.map((r) => r.source)).toEqual([
      'LEGACY_BASELINE',
      'NATIVE',
    ]);
    expect((await history(legacy.id)).map((r) => r.trigger)).toEqual([
      'CRITERIA_CHANGED',
    ]);
  });
  it('duplicate concurrent submissions persist one application and one initial assessment', async () => {
    const row = await listing();
    const user = await applicant();
    const results = await Promise.allSettled([
      lifecycle.apply(row.id, user.id),
      lifecycle.apply(row.id, user.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.application.count({ where: { listingId: row.id } }),
    ).toBe(1);
    expect(
      await prisma.applicationEligibilityAssessment.count({
        where: { listingId: row.id, trigger: 'APPLICATION_CREATED' },
      }),
    ).toBe(1);
  });
});
