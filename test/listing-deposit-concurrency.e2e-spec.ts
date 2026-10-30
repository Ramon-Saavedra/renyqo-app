import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { Pool } from 'pg';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import {
  PrismaClient,
  type Prisma,
  type Listing,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ListingsService } from '../src/listings/listings.service';
import { ListingInputRules } from '../src/listings/listing-input-rules';
import type { UpdateListingDto } from '../src/listings/dto/update-listing.dto';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

jest.setTimeout(20000);

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected response object');
  return value as Record<string, unknown>;
}

describe('Listing deposit consistency (isolated PostgreSQL schema)', () => {
  const schema = `deposit_${randomUUID().replaceAll('-', '')}`;
  const applicationName = schema;
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let service: ListingsService;
  let agent: ReturnType<typeof request.agent>;
  let foreignAgent: ReturnType<typeof request.agent>;
  let providerId: string;
  let displayOrder = 0;
  const rules = new ListingInputRules();

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
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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
    // Authenticated HTTP coverage uses real Passport/guards, with test-only memory sessions.
    app.use(
      session({
        secret: process.env['SESSION_SECRET'],
        resave: false,
        saveUninitialized: false,
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());
    await app.init();
    service = app.get(ListingsService);
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
          email: `${randomUUID()}@deposit.test`,
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
    if (admin) {
      if (!/^deposit_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      // Only this suite's newly created schema is removed; public/dev data is untouched.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  function listing() {
    return prisma.listing.create({
      data: {
        providerId,
        displayOrder: ++displayOrder,
        title: 'Original',
        city: 'Berlin',
        coldRent: 1000,
        depositMonths: 2,
        deposit: 2000,
      },
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
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM listings%'",
            [applicationName],
          );
          if (result.rows[0].n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          'Competing PATCH did not wait on the PostgreSQL row lock',
        );
      },
    };
  }

  const cases: { name: string; a: UpdateListingDto; b: UpdateListingDto }[] = [
    { name: 'rent vs months', a: { coldRent: 1200 }, b: { depositMonths: 3 } },
    {
      name: 'rent vs unrelated title',
      a: { coldRent: 1200 },
      b: { title: 'Edited' },
    },
    { name: 'rent vs rent', a: { coldRent: 1200 }, b: { coldRent: 1400 } },
    {
      name: 'months vs months',
      a: { depositMonths: 1 },
      b: { depositMonths: 3 },
    },
    {
      name: 'unrelated title vs city',
      a: { title: 'Edited' },
      b: { city: 'Hamburg' },
    },
  ];

  describe('PostgreSQL integration', () => {
    for (const scenario of cases) {
      it.each([false, true])(
        `${scenario.name}, reversed=%s: preserves both patches and the canonical amount`,
        async (reverse) => {
          const row = await listing();
          const firstPatch = reverse ? scenario.b : scenario.a,
            secondPatch = reverse ? scenario.a : scenario.b;
          const gate = holdFirstListingLock(row.id);
          let first: Promise<Listing> | undefined,
            second: Promise<Listing> | undefined;
          try {
            first = service.update(row.id, providerId, firstPatch);
            await gate.locked;
            second = service.update(row.id, providerId, secondPatch);
            await gate.waitForDatabaseWaiter();
            gate.release();
            await Promise.all([first, second]);
            // The blocked Serializable snapshot must restart against the committed row.
            expect(gate.attempts()).toBeGreaterThan(2);
          } finally {
            gate.release();
            await Promise.allSettled([first, second]);
            gate.spy.mockRestore();
          }
          const final = await prisma.listing.findUniqueOrThrow({
            where: { id: row.id },
          });
          const expected = { ...row, ...firstPatch, ...secondPatch };
          expect(final).toMatchObject({
            coldRent: expected.coldRent,
            depositMonths: expected.depositMonths,
            title: expected.title,
            city: expected.city,
          });
          expect(final.deposit).toBe(
            rules.calculateDeposit(final.coldRent!, final.depositMonths),
          );
          if (scenario.name === 'rent vs months')
            expect(final.deposit).toBe(3600);
        },
      );
    }

    it('allows a different listing to finish while the first listing is locked', async () => {
      const a = await listing(),
        b = await listing(),
        gate = holdFirstListingLock(a.id);
      let pending: Promise<Listing> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        pending = service.update(a.id, providerId, { coldRent: 1200 });
        await gate.locked;
        const result = await Promise.race([
          service.update(b.id, providerId, { depositMonths: 3 }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Unrelated listing was blocked')),
              2000,
            );
          }),
        ]);
        expect(result.deposit).toBe(3000);
      } finally {
        if (timer) clearTimeout(timer);
        gate.release();
        await pending;
        gate.spy.mockRestore();
      }
    });

    it('rolls back an update if execution fails after its database write', async () => {
      const row = await listing(),
        run = prisma.$transaction.bind(prisma) as Runner;
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementation(
          (operation: Parameters<Runner>[0], options?: Parameters<Runner>[1]) =>
            run(async (tx) => {
              await operation(tx);
              throw new Error('after-write failure');
            }, options),
        );
      try {
        await expect(
          service.update(row.id, providerId, {
            coldRent: 1200,
            title: 'Should roll back',
          }),
        ).rejects.toThrow('after-write failure');
      } finally {
        spy.mockRestore();
      }
      expect(
        await prisma.listing.findUniqueOrThrow({ where: { id: row.id } }),
      ).toEqual(row);
    });

    it('recalculates from a newly committed counterpart after a rolled-back attempt', async () => {
      const row = await listing(),
        run = prisma.$transaction.bind(prisma) as Runner;
      let fail = true,
        observedRollback = false;
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementation(
          (operation: Parameters<Runner>[0], options?: Parameters<Runner>[1]) =>
            run(async (tx) => {
              const result = await operation(tx);
              if (fail) {
                fail = false;
                throw new PrismaClientKnownRequestError('retry deposit', {
                  code: 'P2034',
                  clientVersion: 'test',
                });
              }
              return result;
            }, options).catch(async (error) => {
              if (!observedRollback) {
                observedRollback = true;
                expect(
                  await prisma.listing.findUniqueOrThrow({
                    where: { id: row.id },
                  }),
                ).toEqual(row);
                await prisma.listing.update({
                  where: { id: row.id },
                  data: { depositMonths: 3, deposit: 3000 },
                });
              }
              throw error;
            }),
        );
      try {
        await service.update(row.id, providerId, { coldRent: 1200 });
      } finally {
        spy.mockRestore();
      }
      expect(
        await prisma.listing.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ coldRent: 1200, depositMonths: 3, deposit: 3600 });
    });
  });

  describe('authenticated HTTP', () => {
    it('preserves PATCH/GET financial and unrelated-field contracts', async () => {
      const row = await listing(),
        path = `/api/v1/provider/listings/${row.id}`;
      expect(
        body(
          await agent
            .patch(path)
            .send({ coldRent: 1234.56, title: 'HTTP title' })
            .expect(200),
        ),
      ).toMatchObject({
        coldRent: 1234.56,
        depositMonths: 2,
        deposit: 2469.12,
        title: 'HTTP title',
      });
      await agent.patch(path).send({ depositMonths: 3 }).expect(200);
      expect(body(await agent.get(path).expect(200))).toMatchObject({
        coldRent: 1234.56,
        depositMonths: 3,
        deposit: rules.calculateDeposit(1234.56, 3),
        title: 'HTTP title',
      });
    });

    it('keeps validation, ownership and not-found status codes and leaves failed rows unchanged', async () => {
      const row = await listing(),
        path = `/api/v1/provider/listings/${row.id}`;
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .patch(path)
        .send({ title: 'Unauthorized' })
        .expect(401);
      await foreignAgent.patch(path).send({ coldRent: 1200 }).expect(404);
      await agent
        .patch(`/api/v1/provider/listings/${randomUUID()}`)
        .send({ title: 'Missing' })
        .expect(404);
      await agent.patch(path).send({ depositMonths: 4 }).expect(400);
      await agent.patch(path).send({ deposit: 999 }).expect(400);
      expect(
        await prisma.listing.findUniqueOrThrow({ where: { id: row.id } }),
      ).toEqual(row);
    });

    it.each([false, true])(
      'serializes concurrent HTTP rent/month PATCHes, reversed=%s',
      async (reverse) => {
        const row = await listing(),
          path = `/api/v1/provider/listings/${row.id}`,
          gate = holdFirstListingLock(row.id);
        const a = reverse ? { depositMonths: 3 } : { coldRent: 1200 },
          b = reverse ? { coldRent: 1200 } : { depositMonths: 3 };
        let first: Promise<Response> | undefined,
          second: Promise<Response> | undefined;
        try {
          first = agent
            .patch(path)
            .send(a)
            .then((response) => response);
          await gate.locked;
          second = agent
            .patch(path)
            .send(b)
            .then((response) => response);
          await gate.waitForDatabaseWaiter();
          gate.release();
          const responses = await Promise.all([first, second]);
          expect(responses.map((response) => response.status)).toEqual([
            200, 200,
          ]);
        } finally {
          gate.release();
          await Promise.allSettled([first, second]);
          gate.spy.mockRestore();
        }
        expect(body(await agent.get(path).expect(200))).toMatchObject({
          coldRent: 1200,
          depositMonths: 3,
          deposit: 3600,
        });
      },
    );
  });
});
