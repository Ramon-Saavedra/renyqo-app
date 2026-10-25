import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ProviderApplicationCurationService } from '../src/applications/provider-application-curation.service';
import { ListingsService } from '../src/listings/listings.service';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:https';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { jest } from '@jest/globals';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { AppModule } from '../src/app.module';
import { ApplicationActivityService } from '../src/applications/application-activity.service';
import { ViewingLifecycleService } from '../src/applications/viewing-lifecycle.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { runSerializableTransaction } from '../src/prisma/run-serializable-transaction';
import {
  ApplicationStatus,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;
type Store = InstanceType<ReturnType<typeof connectPgSimple>>;

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!isRecord(value)) {
    throw new Error('Expected an object response');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string ${key}`);
  return value;
}

describe('Viewing lifecycle integration E2E', () => {
  let now = new Date('2027-01-01T10:00:00Z');
  let app: INestApplication;
  let prisma: PrismaService;
  let store: Store;
  let server: RequestTarget;
  let certificate: Buffer;
  let tlsDirectory: string | undefined;
  let provider: { agent: Agent; id: string };
  let applicant: { agent: Agent; id: string };
  let applicationId: string;
  let listingId: string;

  function path(side: 'provider' | 'applicant', suffix = ''): string {
    return `/api/v1/${side}/applications/${applicationId}/viewings${suffix}`;
  }

  async function register(role: 'applicant' | 'provider') {
    const agent = request.agent(server).ca(certificate);
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: `Conversation ${role}`,
        email: `${randomUUID()}@e2e.renyqo.test`,
        password: 'StrongPass123',
        role,
        acceptedTerms: true,
        acceptedPrivacy: true,
        ...(role === 'provider' ? { providerType: 'private' } : {}),
      })
      .expect(201);
    const cookies: unknown = response.headers['set-cookie'];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/; Secure(?:;|$)/),
        expect.stringMatching(/; HttpOnly(?:;|$)/),
        expect.stringMatching(/; SameSite=Lax(?:;|$)/),
      ]),
    );
    return { agent, id: getString(body(response), 'id') };
  }

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
      throw new Error('Dedicated E2E database and reset marker required');
    }
    assertSafeE2EDatabaseUrl(url);
    process.env['DATABASE_URL'] = url;
    process.env['NODE_ENV'] = 'test';
    process.env['SESSION_SECRET'] =
      'e2e-session-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ViewingClock)
      .useValue({ now: () => now })
      .compile();
    tlsDirectory = mkdtempSync(join(tmpdir(), 'renyqo-conversation-tls-'));
    const keyPath = join(tlsDirectory, 'key.pem');
    const certPath = join(tlsDirectory, 'cert.pem');
    const openssl =
      process.platform === 'win32'
        ? join(
            process.env['ProgramFiles'] ?? 'C:\\Program Files',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          )
        : 'openssl';
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-noenc',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore', timeout: 10000 },
    );
    certificate = readFileSync(certPath);
    app = module.createNestApplication({
      httpsOptions: { key: readFileSync(keyPath), cert: certificate },
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    const PgStore = connectPgSimple(session);
    store = new PgStore({
      conString: url,
      tableName: 'user_sessions',
      createTableIfMissing: false,
    });
    app.use(
      session({
        store,
        secret: process.env['SESSION_SECRET'],
        resave: false,
        saveUninitialized: false,
        name: 'sid',
        cookie: { secure: true, httpOnly: true, sameSite: 'lax' },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());
    prisma = app.get(PrismaService);
    await app.init();
    const target: unknown = app.getHttpServer();
    if (!(target instanceof Server)) throw new Error('Missing HTTP server');
    server = target;
  });

  beforeEach(async () => {
    now = new Date('2027-01-01T10:00:00Z');
    provider = await register('provider');
    applicant = await register('applicant');
    const listing = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 1,
        status: ListingStatus.PUBLISHED,
        title: 'Conversation listing',
        publishedAt: new Date(),
      },
    });
    listingId = listing.id;
    const application = await prisma.application.create({
      data: {
        listingId,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    applicationId = application.id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const url = process.env['E2E_DATABASE_URL'];
    if (
      !url ||
      process.env['DATABASE_URL'] !== url ||
      process.env['NODE_ENV'] !== 'test' ||
      process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
    ) {
      throw new Error('Unsafe E2E cleanup configuration');
    }
    assertSafeE2EDatabaseUrl(url);
    if (!prisma) return;
    await prisma.$executeRaw`TRUNCATE TABLE application_no_show_consequences, viewing_command_receipts, viewing_workflows, viewing_proposals, viewing_appointments, application_consideration_positions, application_viewing_interests, application_viewing_outcomes, application_viewings`;
    await prisma.application.deleteMany();
    await prisma.listingReport.deleteMany();
    await prisma.savedListing.deleteMany();
    await prisma.listingImage.deleteMany();
    await prisma.listingEvent.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.applicantProfile.deleteMany();
    await prisma.passwordResetToken.deleteMany();
    await prisma.userSession.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        if (store) await Promise.resolve(store.close());
      } finally {
        if (tlsDirectory)
          rmSync(tlsDirectory, { recursive: true, force: true });
      }
    }
  });

  function endpoint(side: 'provider' | 'applicant', suffix = '') {
    return `/api/v1/${side}/applications/${applicationId}/viewing-workflow${suffix}`;
  }
  function nested(row: Record<string, unknown>, key: string) {
    const value = row[key];
    if (!isRecord(value)) throw new Error(`Expected object ${key}`);
    return value;
  }
  function schedule(startsAt = '2027-01-03T10:00:00.000Z') {
    return {
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
      timeZone: 'Europe/Berlin',
      message: 'Meet at the entrance',
    };
  }
  function command(
    expectedWorkflowRevision: number,
    fields: Record<string, unknown> = {},
    requestKey = randomUUID(),
  ) {
    return { requestKey, expectedWorkflowRevision, ...fields };
  }
  async function snapshot(side: 'provider' | 'applicant' = 'provider') {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .get(endpoint(side))
        .expect(200),
    );
  }
  async function post(
    side: 'provider' | 'applicant',
    suffix: string,
    input: Record<string, unknown>,
    status = 200,
  ) {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .post(endpoint(side, suffix))
        .send(input)
        .expect(status),
    );
  }
  async function invite() {
    return post('provider', '/invitations', command(0, schedule()));
  }
  async function confirmed() {
    const id = getString(await invite(), 'proposalId');
    return getString(
      await post('applicant', `/proposals/${id}/accept`, command(1)),
      'appointmentId',
    );
  }
  async function legacyProposal() {
    const s = schedule();
    return getString(
      body(
        await provider.agent
          .post(path('provider'))
          .send({
            requestKey: randomUUID(),
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            timeZone: s.timeZone,
            providerNote: 'Legacy note',
          })
          .expect(201),
      ),
      'viewingId',
    );
  }
  async function legacySnapshot(id: string) {
    await runSerializableTransaction(prisma, async (tx) => {
      const row = await tx.applicationViewing.findUniqueOrThrow({
        where: { id },
      });
      await tx.viewingWorkflow.create({
        data: {
          id: applicationId,
          applicationId,
          mode: 'LEGACY',
          pendingProposalId: id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
      await tx.$executeRaw`INSERT INTO viewing_proposals SELECT * FROM legacy_viewing_proposal_rows(${applicationId}::uuid)`;
    });
  }

  const lifecycle = () => app.get(ApplicationLifecycleService);
  const curation = () => app.get(ProviderApplicationCurationService);
  const listings = () => app.get(ListingsService);
  async function state() {
    return prisma.viewingWorkflow.findUniqueOrThrow({
      where: { applicationId },
      include: { pendingProposal: true, confirmedAppointment: true },
    });
  }
  async function application() {
    return prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
    });
  }
  async function releaseCooldown() {
    await prisma.listingEvent.updateMany({
      where: { applicationId },
      data: { occurredAt: new Date(Date.now() - 60 * 60_000) },
    });
  }
  async function complete() {
    const id = await confirmed();
    now = new Date('2027-01-03T10:30:00Z');
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'COMPLETED' }),
    );
    expect(nested(await snapshot(), 'postViewing')).toMatchObject({
      appointmentId: id,
      interestState: 'PENDING',
      interestDeadlineAt: new Date(
        now.getTime() + 48 * 60 * 60_000,
      ).toISOString(),
      interestResponseBlockedReason: null,
    });
    return id;
  }
  async function fillWithWaiting() {
    for (let i = 0; i < 4; i++) {
      const user = await register('applicant');
      await prisma.application.create({
        data: {
          listingId,
          applicantId: user.id,
          status: 'ACTIVE',
          activeAt: now,
        },
      });
    }
    const user = await register('applicant');
    return prisma.application.create({
      data: { listingId, applicantId: user.id, status: 'WAITING' },
    });
  }

  async function completedLegacyCutover() {
    const id = await legacyProposal();
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    now = new Date('2027-01-03T10:30:00Z');
    await provider.agent
      .patch(path('provider', `/${id}/complete`))
      .send({})
      .expect(200);
    await post('provider', '/reconcile', command(0));
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({
      interestState: 'LEGACY_UNANSWERED',
      interestDeadlineAt: null,
    });
    return id;
  }

  it.each(['reject', 'withdraw', 'archive', 'draft'] as const)(
    'terminalizes unanswered legacy interest after cutover on %s without inventing a deadline',
    async (kind) => {
      const id = await completedLegacyCutover();
      if (kind === 'reject')
        await curation().reject(applicationId, provider.id);
      else if (kind === 'withdraw')
        await lifecycle().withdraw(applicationId, applicant.id);
      else if (kind === 'archive')
        await listings().archive(listingId, provider.id);
      else await listings().moveToDraft(listingId, provider.id);
      expect(
        await prisma.viewingAppointment.findUniqueOrThrow({
          where: { viewingId: id },
        }),
      ).toMatchObject({
        interestState: 'CLOSED',
        interestClosedAt: now,
        interestDeadlineAt: null,
      });
      expect(
        nested(await snapshot('applicant'), 'applicantInterest').state,
      ).toBe('CLOSED');
      expect((await snapshot('applicant')).obligations).toEqual([]);
    },
  );

  it('reconcile → reject → restore → new invitation never reactivates the old unanswered interest', async () => {
    const id = await completedLegacyCutover();
    const oldViewing = await prisma.applicationViewing.findUniqueOrThrow({
      where: { id },
    });
    const outcomes = await prisma.applicationViewingOutcome.findMany({
      where: { viewingId: id },
    });
    await curation().reject(applicationId, provider.id);
    const closed = await state();
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      closedAt: closed.closedAt,
      closureReason: closed.closureReason,
      confirmedAppointmentId: null,
      pendingProposalId: null,
    });
    expect((await snapshot('applicant')).obligations).toEqual([]);
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command((await state()).revision, { interest: 'STILL_INTERESTED' }),
      409,
    );
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command((await state()).revision, {
        consideration: 'CONTINUE_CONSIDERING',
      }),
      409,
    );
    const fresh = await post(
      'provider',
      '/invitations',
      command((await state()).revision, schedule('2027-01-05T10:00:00.000Z')),
    );
    expect(getString(fresh, 'proposalId')).not.toBe(id);
    expect((await snapshot('applicant')).obligations).toMatchObject([
      { action: 'APPLICANT_RESPOND_TO_VIEWING' },
    ]);
    expect(
      await post(
        'applicant',
        `/appointments/${id}/interest`,
        command((await state()).revision, { interest: 'STILL_INTERESTED' }),
        409,
      ),
    ).toMatchObject({ reason: 'INTEREST_RESPONSE_UNAVAILABLE' });
    expect(
      await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }),
    ).toEqual(oldViewing);
    expect(
      await prisma.applicationViewingOutcome.findMany({
        where: { viewingId: id },
      }),
    ).toEqual(outcomes);
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({ interestState: 'CLOSED', interestDeadlineAt: null });
  });

  it.each([false, true])(
    'keeps a decision after calendar-only close, then ends it on rejection without re-closing history (legacy=%s)',
    async (legacy) => {
      const id = legacy ? await completedLegacyCutover() : await complete();
      const p = await post(
        'provider',
        '/invitations',
        command((await state()).revision, schedule('2027-01-05T10:00:00.000Z')),
      );
      await post(
        'provider',
        `/${getString(p, 'workflowId')}/close`,
        command((await state()).revision, {
          proposalId: getString(p, 'proposalId'),
          appointmentId: null,
          reason: 'PROVIDER_OPERATIONAL',
        }),
      );
      const closed = await state();
      expect((await snapshot('applicant')).obligations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
          }),
        ]),
      );
      const closedActivities = await prisma.applicationActivity.count({
        where: { applicationId, type: 'VIEWING_WORKFLOW_CLOSED' },
      });
      await curation().reject(applicationId, provider.id);
      expect(await state()).toMatchObject({
        closedAt: closed.closedAt,
        closureReason: 'PROVIDER_CLOSED',
        revision: closed.revision + 1,
      });
      expect(
        await prisma.viewingAppointment.findUniqueOrThrow({
          where: { viewingId: id },
        }),
      ).toMatchObject({ interestState: 'CLOSED' });
      expect(
        await prisma.applicationActivity.count({
          where: { applicationId, type: 'VIEWING_WORKFLOW_CLOSED' },
        }),
      ).toBe(closedActivities);
      await releaseCooldown();
      await curation().restore(applicationId, provider.id);
      expect((await snapshot('applicant')).obligations).toEqual([]);
    },
  );

  it('restore repairs pre-fix unanswered legacy metadata without overwriting its historical closure', async () => {
    const id = await completedLegacyCutover();
    await curation().reject(applicationId, provider.id);
    const closed = await state();
    // Reproduce the metadata left by the previously approved implementation.
    await prisma.viewingAppointment.update({
      where: { viewingId: id },
      data: { interestState: 'LEGACY_UNANSWERED', interestClosedAt: null },
    });
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    expect(await state()).toMatchObject({
      closedAt: closed.closedAt,
      closureReason: closed.closureReason,
    });
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({ interestState: 'CLOSED', interestDeadlineAt: null });
    expect((await snapshot('applicant')).obligations).toEqual([]);
  });

  it('blocks a pre-fix restored snapshot and reissues only a new invitation, never the old interest', async () => {
    const id = await completedLegacyCutover();
    await curation().reject(applicationId, provider.id);
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    // This is the already-restored snapshot that could exist before Phase A.
    await prisma.viewingAppointment.update({
      where: { viewingId: id },
      data: { interestState: 'LEGACY_UNANSWERED', interestClosedAt: null },
    });
    expect((await snapshot('applicant')).obligations).toEqual([]);
    expect((await snapshot('provider')).obligations).toEqual([]);
    const before = await state();
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command(before.revision, { interest: 'STILL_INTERESTED' }),
      409,
    );
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command(before.revision, { consideration: 'CONTINUE_CONSIDERING' }),
      409,
    );
    expect(await state()).toEqual(before);
    await post(
      'provider',
      '/invitations',
      command(before.revision, schedule('2027-01-05T10:00:00.000Z')),
    );
    expect((await snapshot('applicant')).obligations).toMatchObject([
      { action: 'APPLICANT_RESPOND_TO_VIEWING' },
    ]);
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({ interestState: 'CLOSED', interestDeadlineAt: null });
  });

  it('a newer outcome supersedes unanswered legacy interest rather than rediscovering it after no-show', async () => {
    const id = await completedLegacyCutover();
    const p = await post(
      'provider',
      '/invitations',
      command((await state()).revision, schedule('2027-01-05T10:00:00.000Z')),
    );
    const freshId = getString(p, 'proposalId');
    await post(
      'applicant',
      `/proposals/${freshId}/accept`,
      command((await state()).revision),
    );
    now = new Date('2027-01-05T10:30:00Z');
    await post(
      'provider',
      `/appointments/${freshId}/outcome`,
      command((await state()).revision, {
        outcome: 'NO_SHOW',
        absenceSide: 'PROVIDER',
      }),
    );
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({ interestState: 'CLOSED', interestDeadlineAt: null });
    expect((await snapshot('applicant')).obligations).toEqual([]);
  });

  it('preserves already closed historical workflow, ledger and history on repeated closure and later listing archive', async () => {
    await confirmed();
    await curation().reject(applicationId, provider.id);
    const closed = await state();
    const history = await prisma.applicationActivity.findMany({
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    const ledger = await prisma.applicationViewing.findMany({
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    const appointments = await prisma.viewingAppointment.findMany({
      where: { workflowId: closed.id },
      orderBy: { viewingId: 'asc' },
    });
    const proposals = await prisma.viewingProposal.findMany({
      where: { workflowId: closed.id },
      orderBy: { id: 'asc' },
    });
    const outbox = await prisma.outboxEvent.findMany({
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    now = new Date(now.getTime() + 3600000);
    await runSerializableTransaction(prisma, (tx) =>
      app
        .get(ViewingLifecycleService)
        .closeWithinTransaction(
          tx,
          applicationId,
          'LISTING_ARCHIVED',
          'PROVIDER',
          provider.id,
        ),
    );
    expect(
      await prisma.outboxEvent.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(outbox);
    await listings().archive(listingId, provider.id);
    expect(await state()).toEqual(closed);
    expect(
      await prisma.applicationActivity.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(history);
    expect(
      await prisma.applicationViewing.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(ledger);
    expect(
      await prisma.viewingAppointment.findMany({
        where: { workflowId: closed.id },
        orderBy: { viewingId: 'asc' },
      }),
    ).toEqual(appointments);
    expect(
      await prisma.viewingProposal.findMany({
        where: { workflowId: closed.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(proposals);
    expect(
      await prisma.outboxEvent.count({
        where: { applicationId, type: 'application.viewing.changed' },
      }),
    ).toBe(
      outbox.filter((e) => e.type === 'application.viewing.changed').length,
    );
  });

  it.each([false, true])(
    'restore fallback records PROVIDER cleanup without inventing rejection or overwriting an existing closure (closed=%s)',
    async (alreadyClosed) => {
      const id = await legacyProposal();
      await legacySnapshot(id);
      const originalClosedAt = new Date(now);
      if (alreadyClosed)
        await prisma.viewingWorkflow.update({
          where: { applicationId },
          data: {
            revision: { increment: 1 },
            state: 'CLOSED',
            closedAt: originalClosedAt,
            closureReason: 'APPLICATION_REJECTED',
            pendingProposalId: null,
          },
        });
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          status: 'REJECTED',
          rejectedAt: now,
          publicReason: 'NOT_SELECTED',
        },
      });
      await curation().restore(applicationId, provider.id);
      if (alreadyClosed)
        expect((await state()).closedAt).toEqual(originalClosedAt);
      const closed = await prisma.applicationActivity.findFirstOrThrow({
        where: { applicationId, type: 'VIEWING_WORKFLOW_CLOSED' },
      });
      expect(closed).toMatchObject({
        actorType: 'PROVIDER',
        actorUserId: provider.id,
        payload: {
          viewingClosureReason: 'APPLICATION_REJECTED',
          viewingLifecycleContext: 'RESTORE_CLEANUP',
        },
      });
      expect(
        await prisma.applicationActivity.count({
          where: { applicationId, type: 'APPLICATION_REJECTED' },
        }),
      ).toBe(0);
      expect(
        await prisma.applicationActivity.count({
          where: { applicationId, type: 'APPLICATION_RESTORED' },
        }),
      ).toBe(1);
      const publicHistory = await app
        .get(ApplicationActivityService)
        .findForAudience(applicationId, 'APPLICANT', applicant.id);
      expect(
        publicHistory.find((row) => row.id === closed.id)?.payload,
      ).toMatchObject({ viewingLifecycleContext: 'RESTORE_CLEANUP' });
    },
  );

  it.each(['withdraw', 'reject', 'rent', 'archive', 'draft'] as const)(
    'closes future commitments and replacements atomically on %s',
    async (kind) => {
      const id = await confirmed();
      const proposal = getString(
        await post(
          'applicant',
          `/appointments/${id}/alternative`,
          command(2, schedule('2027-01-04T10:00:00.000Z')),
        ),
        'proposalId',
      );
      if (kind === 'withdraw')
        await lifecycle().withdraw(applicationId, applicant.id);
      else if (kind === 'reject')
        await curation().reject(applicationId, provider.id);
      else if (kind === 'rent')
        await listings().rentListing(listingId, provider.id, {
          selectedApplicationId: applicationId,
        });
      else if (kind === 'archive')
        await listings().archive(listingId, provider.id);
      else await listings().moveToDraft(listingId, provider.id);
      expect(await state()).toMatchObject({
        state: 'CLOSED',
        revision: 4,
        pendingProposalId: null,
        confirmedAppointmentId: null,
      });
      expect(
        (
          await prisma.viewingProposal.findUniqueOrThrow({
            where: { id: proposal },
          })
        ).resolution,
      ).toBe('CLOSED');
      expect(
        (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('CANCELLED');
      expect(
        await prisma.viewingAppointment.findUniqueOrThrow({
          where: { viewingId: id },
        }),
      ).toMatchObject({ cancellationReason: 'APPLICATION_ENDED' });
      expect(
        await prisma.applicationActivity.count({
          where: { applicationId, type: 'VIEWING_WORKFLOW_CLOSED' },
        }),
      ).toBe(1);
      await post('provider', `/proposals/${proposal}/accept`, command(3), 409);
    },
  );

  it.each(['archive', 'rent'] as const)(
    'filters historical and absent workflows during bulk listing %s',
    async (kind) => {
      await confirmed();
      await curation().reject(applicationId, provider.id);
      const historical = await state();
      const priorHistory = await prisma.applicationActivity.count({
        where: { applicationId },
      });
      const users = Array.from({ length: 21 }, () => ({
        id: randomUUID(),
        name: 'Volume fixture',
        email: `${randomUUID()}@e2e.renyqo.test`,
        passwordHash: 'unused',
        acceptedTermsAt: now,
        acceptedPrivacyAt: now,
      }));
      await prisma.user.createMany({ data: users });
      await prisma.application.createMany({
        data: users.map((u, i) => ({
          listingId,
          applicantId: u.id,
          status: i === 0 ? ('ACTIVE' as const) : ('WAITING' as const),
          activeAt: i === 0 ? now : null,
        })),
      });
      const selected = await prisma.application.findFirstOrThrow({
        where: { applicantId: users[0].id, listingId },
      });
      // A real new commitment still closes; the historical one must not even be passed to the closer.
      await prisma.applicationViewing.create({
        data: {
          applicationId: selected.id,
          round: 1,
          status: 'PROPOSED',
          startsAt: new Date('2027-01-06T10:00:00Z'),
          endsAt: new Date('2027-01-06T10:30:00Z'),
          timeZone: 'Europe/Berlin',
          requestKey: randomUUID(),
          requestHash: 'b'.repeat(64),
        },
      });
      const close = jest.spyOn(
        app.get(ViewingLifecycleService),
        'closeWithinTransaction',
      );
      const priorEvents = await prisma.outboxEvent.groupBy({
        by: ['applicationId'],
        where: {
          applicationId: { in: [applicationId, selected.id] },
          type: 'application.lifecycle.changed',
        },
        _count: { _all: true },
      });
      if (kind === 'archive') await listings().archive(listingId, provider.id);
      else
        await listings().rentListing(listingId, provider.id, {
          selectedApplicationId: selected.id,
        });
      expect(close.mock.calls.map((call) => call[1])).toEqual([selected.id]);
      expect(await state()).toEqual(historical);
      expect(
        await prisma.applicationActivity.count({ where: { applicationId } }),
      ).toBe(priorHistory);
      expect(
        await prisma.applicationViewing.findFirst({
          where: { applicationId: selected.id },
        }),
      ).toMatchObject({ status: 'CANCELLED' });
      const apps = await prisma.application.findMany({ where: { listingId } });
      for (const row of apps) {
        expect(
          await prisma.outboxEvent.count({
            where: {
              applicationId: row.id,
              type: 'application.lifecycle.changed',
            },
          }),
        ).toBe(
          1 +
            (priorEvents.find((event) => event.applicationId === row.id)?._count
              ._all ?? 0),
        );
        if (row.id === applicationId) continue;
        expect(row.status).toBe(
          kind === 'archive'
            ? row.id === selected.id
              ? 'ACTIVE'
              : 'WAITING'
            : row.id === selected.id
              ? 'ACCEPTED'
              : 'REJECTED',
        );
        if (kind === 'rent' && row.id !== selected.id)
          expect(
            await prisma.applicationActivity.findFirst({
              where: { applicationId: row.id, type: 'APPLICATION_REJECTED' },
            }),
          ).toMatchObject({ visibility: 'APPLICANT' });
      }
    },
  );

  it('closes non-selected rented applications and keeps WAITING privacy', async () => {
    const id = await confirmed();
    const waiting = await fillWithWaiting();
    const selected = await prisma.application.findFirstOrThrow({
      where: { listingId, status: 'ACTIVE', id: { not: applicationId } },
    });
    await listings().rentListing(listingId, provider.id, {
      selectedApplicationId: selected.id,
    });
    expect(await application()).toMatchObject({
      status: 'REJECTED',
      publicReason: 'LISTING_RENTED',
    });
    expect((await state()).closureReason).toBe('LISTING_RENTED');
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('CANCELLED');
    expect(
      await prisma.applicationActivity.findFirst({
        where: { applicationId: waiting.id, type: 'APPLICATION_REJECTED' },
      }),
    ).toMatchObject({ visibility: 'APPLICANT' });
  });

  it('eligibility rejection closes the workflow in the profile revalidation transaction', async () => {
    await confirmed();
    await prisma.listing.update({
      where: { id: listingId },
      data: { minimumHouseholdNetIncome: 99999 },
    });
    const profile = await prisma.applicantProfile.upsert({
      where: { applicantId: applicant.id },
      create: { applicantId: applicant.id },
      update: {},
    });
    await runSerializableTransaction(prisma, (tx) =>
      lifecycle().revalidateActiveAndWaitingApplications(
        tx,
        applicant.id,
        profile,
      ),
    );
    expect(await application()).toMatchObject({
      status: 'REJECTED',
      publicReason: 'PROFILE_NO_LONGER_ELIGIBLE',
    });
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      closureReason: 'ELIGIBILITY_REJECTED',
      revision: 3,
    });
  });

  it('restore ACTIVE never revives a commitment and allows only a new invitation', async () => {
    const id = await confirmed();
    await curation().reject(applicationId, provider.id);
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    expect((await application()).status).toBe('ACTIVE');
    expect(await state()).toMatchObject({
      revision: 4,
      state: 'CLOSED',
      pendingProposalId: null,
      confirmedAppointmentId: null,
    });
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('CANCELLED');
    await post('applicant', `/proposals/${id}/accept`, command(2), 409);
    await post(
      'provider',
      '/invitations',
      command(4, schedule('2027-01-06T10:00:00.000Z')),
    );
  });

  it('restore WAITING hides the workflow from the provider', async () => {
    await confirmed();
    await curation().reject(applicationId, provider.id);
    await fillWithWaiting(); // four ACTIVE; add a fifth before restoring.
    const other = await register('applicant');
    await prisma.application.create({
      data: {
        listingId,
        applicantId: other.id,
        status: 'ACTIVE',
        activeAt: now,
      },
    });
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    expect((await application()).status).toBe('WAITING');
    await provider.agent.get(endpoint('provider')).expect(404);
    expect(await snapshot('applicant')).toMatchObject({
      pendingProposal: null,
      confirmedAppointment: null,
    });
  });

  it('does not cancel an appointment once started and preserves it for real attendance handling after termination', async () => {
    const id = await confirmed();
    now = new Date('2027-01-03T10:00:00Z');
    expect(
      await post('applicant', `/appointments/${id}/cancel`, command(2), 409),
    ).toMatchObject({ reason: 'APPOINTMENT_ALREADY_STARTED' });
    await lifecycle().withdraw(applicationId, applicant.id);
    expect(
      await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'OUTCOME_PENDING', cancelledAt: null });
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      confirmedAppointmentId: null,
    });
    now = new Date('2027-01-03T10:30:00Z');
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(3, { outcome: 'COMPLETED' }),
    );
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({ interestState: 'CLOSED', interestDeadlineAt: null });
    expect((await application()).status).toBe('WITHDRAWN');
  });

  it('confirmed post-viewing disinterest withdraws and promotes atomically; confirmation is mandatory', async () => {
    const id = await complete();
    const waiting = await fillWithWaiting();
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command(3, { interest: 'NOT_INTERESTED' }),
      400,
    );
    const input = command(3, {
      interest: 'NOT_INTERESTED',
      confirmWithdrawal: true,
    });
    const result = await post(
      'applicant',
      `/appointments/${id}/interest`,
      input,
    );
    expect(
      await post('applicant', `/appointments/${id}/interest`, input),
    ).toEqual(result);
    expect((await application()).status).toBe('WITHDRAWN');
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      (
        await prisma.applicationViewingInterest.findUniqueOrThrow({
          where: { viewingId: id },
        })
      ).interest,
    ).toBe('NOT_INTERESTED');
    expect(await state()).toMatchObject({ state: 'CLOSED', revision: 4 });
  });

  it('provider decision uses real NOT_SELECTED rejection/cooldown and restores without old decisions', async () => {
    const id = await complete();
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command(3, { consideration: 'DO_NOT_CONTINUE' }),
    );
    expect(await application()).toMatchObject({
      status: 'REJECTED',
      publicReason: 'NOT_SELECTED',
    });
    expect((await state()).providerConsideration).toBe('DO_NOT_CONTINUE');
    await expect(
      curation().restore(applicationId, provider.id),
    ).rejects.toMatchObject({ status: 429 });
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      providerConsideration: 'UNDECIDED',
      confirmedAppointmentId: null,
    });
  });

  it('records 48h interest and expires through SYSTEM rejection with capacity promotion, never withdrawal', async () => {
    const id = await complete();
    const waiting = await fillWithWaiting();
    const deadline = new Date(now.getTime() + 48 * 60 * 60_000);
    expect(
      (
        await prisma.viewingAppointment.findUniqueOrThrow({
          where: { viewingId: id },
        })
      ).interestDeadlineAt,
    ).toEqual(deadline);
    const expire = (revision: number, time: Date) =>
      runSerializableTransaction(prisma, (tx) =>
        lifecycle().expireViewingInterestWithinTransaction(
          tx,
          applicationId,
          id,
          revision,
          time,
        ),
      );
    expect(await expire(3, new Date(deadline.getTime() - 1))).toBe(false);
    expect(await expire(2, deadline)).toBe(false);
    now = deadline;
    expect(await expire(3, deadline)).toBe(true);
    expect(await expire(3, deadline)).toBe(false);
    expect(await application()).toMatchObject({
      status: 'REJECTED',
      publicReason: 'POST_VIEWING_RESPONSE_EXPIRED',
      withdrawnAt: null,
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      await prisma.applicationActivity.findFirst({
        where: { applicationId, type: 'APPLICATION_REJECTED' },
      }),
    ).toMatchObject({ actorType: 'SYSTEM' });
    expect(
      await prisma.applicationActivity.count({
        where: { applicationId, type: 'APPLICATION_WITHDRAWN' },
      }),
    ).toBe(0);
  });

  it('interest response and timeout race cannot produce both a response and system rejection', async () => {
    const id = await complete();
    now = new Date(now.getTime() + 48 * 60 * 60_000);
    const results = await Promise.all([
      applicant.agent
        .post(endpoint('applicant', `/appointments/${id}/interest`))
        .send(command(3, { interest: 'STILL_INTERESTED' })),
      runSerializableTransaction(prisma, (tx) =>
        lifecycle().expireViewingInterestWithinTransaction(
          tx,
          applicationId,
          id,
          3,
          now,
        ),
      ),
    ]);
    expect(results[0].status).toBe(409);
    // The late command can now persist expiry itself before the worker wins.
    expect(typeof results[1]).toBe('boolean');
    expect((await application()).publicReason).toBe(
      'POST_VIEWING_RESPONSE_EXPIRED',
    );
    expect(
      await prisma.applicationActivity.count({
        where: { applicationId, type: 'VIEWING_INTEREST_EXPIRED' },
      }),
    ).toBe(1);
    expect(
      await prisma.applicationViewingInterest.count({
        where: { viewingId: id },
      }),
    ).toBe(0);
  });

  it.each(['accept', 'replacement', 'cancel'] as const)(
    'serializes withdrawal racing with %s',
    async (action) => {
      const id =
        action === 'accept'
          ? getString(await invite(), 'proposalId')
          : await confirmed();
      const revision = action === 'accept' ? 1 : 2;
      const side = action === 'replacement' ? 'provider' : 'applicant';
      const target =
        action === 'accept'
          ? `/proposals/${id}/accept`
          : `/appointments/${id}/${action}`;
      const [response] = await Promise.all([
        (side === 'provider' ? provider : applicant).agent
          .post(endpoint(side, target))
          .send(
            command(
              revision,
              action === 'replacement'
                ? schedule('2027-01-05T10:00:00.000Z')
                : {},
            ),
          ),
        lifecycle().withdraw(applicationId, applicant.id),
      ]);
      expect([200, 409]).toContain(response.status);
      if (response.status === 409)
        expect(body(response).code).toBe('VIEWING_STATE_CHANGED');
      expect((await application()).status).toBe('WITHDRAWN');
      expect(await state()).toMatchObject({
        state: 'CLOSED',
        pendingProposalId: null,
        confirmedAppointmentId: null,
      });
      expect(
        await prisma.applicationViewing.count({
          where: { applicationId, status: 'ACCEPTED' },
        }),
      ).toBe(0);
    },
  );

  it.each(['reject', 'rent'] as const)(
    'serializes invitation acceptance with %s',
    async (action) => {
      const id = getString(await invite(), 'proposalId');
      const [response] = await Promise.all([
        applicant.agent
          .post(endpoint('applicant', `/proposals/${id}/accept`))
          .send(command(1)),
        action === 'reject'
          ? curation().reject(applicationId, provider.id)
          : listings().rentListing(listingId, provider.id, {
              selectedApplicationId: applicationId,
            }),
      ]);
      expect([200, 409]).toContain(response.status);
      expect(await state()).toMatchObject({
        state: 'CLOSED',
        pendingProposalId: null,
        confirmedAppointmentId: null,
      });
    },
  );

  it('serializes rejection/withdrawal/rental selection so only one terminal lifecycle wins', async () => {
    await confirmed();
    const results = await Promise.allSettled([
      curation().reject(applicationId, provider.id),
      lifecycle().withdraw(applicationId, applicant.id),
      listings().rentListing(listingId, provider.id, {
        selectedApplicationId: applicationId,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['REJECTED', 'WITHDRAWN', 'ACCEPTED']).toContain(
      (await application()).status,
    );
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      pendingProposalId: null,
      confirmedAppointmentId: null,
    });
  });

  it('rolls back interest, withdrawal and promotion when transactional activity fails', async () => {
    const id = await complete();
    const waiting = await fillWithWaiting();
    jest
      .spyOn(app.get(ApplicationActivityService), 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('lifecycle activity failure'));
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command(3, { interest: 'NOT_INTERESTED', confirmWithdrawal: true }),
      500,
    );
    expect((await application()).status).toBe('ACTIVE');
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe('WAITING');
    expect(
      await prisma.applicationViewingInterest.count({
        where: { viewingId: id },
      }),
    ).toBe(0);
    expect((await state()).revision).toBe(3);
  });

  it('closes legacy ledger commitments without trusting or reviving imported snapshots', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    await curation().reject(applicationId, provider.id);
    expect(await state()).toMatchObject({
      mode: 'LEGACY',
      state: 'CLOSED',
      pendingProposalId: null,
      confirmedAppointmentId: null,
    });
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('CANCELLED');
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    await post('provider', '/reconcile', command(2));
    expect(await state()).toMatchObject({
      mode: 'CURRENT',
      state: 'CLOSED',
      pendingProposalId: null,
      confirmedAppointmentId: null,
    });
  });

  it.each([true, false])(
    'does not revive completed legacy interest during cutover after restore (imported=%s)',
    async (imported) => {
      const id = await legacyProposal();
      if (imported) await legacySnapshot(id);
      await applicant.agent
        .patch(path('applicant', `/${id}/accept`))
        .send({})
        .expect(200);
      now = new Date('2027-01-03T10:30:00Z');
      await provider.agent
        .patch(path('provider', `/${id}/complete`))
        .send({})
        .expect(200);
      await curation().reject(applicationId, provider.id);
      await releaseCooldown();
      await curation().restore(applicationId, provider.id);
      const revision = (await state()).revision;
      await post('provider', '/reconcile', command(revision));
      expect(await snapshot('applicant')).toMatchObject({
        obligations: [],
        applicantInterest: { state: 'CLOSED' },
      });
      const current = await state();
      await post(
        'provider',
        '/invitations',
        command(current.revision, schedule('2027-01-05T10:00:00.000Z')),
      );
      const view = await snapshot('applicant');
      expect(view.applicantInterest).toMatchObject({ state: 'CLOSED' });
      expect(view.obligations).toMatchObject([
        { action: 'APPLICANT_RESPOND_TO_VIEWING' },
      ]);
    },
  );

  it.each([true, false])(
    'shows a fresh legacy invitation after reject/restore and preserves closed interest (imported=%s)',
    async (imported) => {
      const old = await legacyProposal();
      if (imported) await legacySnapshot(old);
      await applicant.agent
        .patch(path('applicant', `/${old}/accept`))
        .send({})
        .expect(200);
      now = new Date('2027-01-03T10:30:00Z');
      await provider.agent
        .patch(path('provider', `/${old}/complete`))
        .send({})
        .expect(200);
      await curation().reject(applicationId, provider.id);
      await releaseCooldown();
      await curation().restore(applicationId, provider.id);
      const closed = await state();
      expect((await snapshot('applicant')).obligations).toEqual([]);
      now = new Date('2027-01-04T10:00:00Z');
      const invitation = getString(
        body(
          await provider.agent
            .post(path('provider'))
            .send({
              requestKey: randomUUID(),
              startsAt: '2027-01-05T10:00:00Z',
              endsAt: '2027-01-05T10:30:00Z',
              timeZone: 'Europe/Berlin',
            })
            .expect(201),
        ),
        'viewingId',
      );
      expect(await state()).toEqual(closed);
      const projection = await snapshot('applicant');
      expect(projection.obligations).toMatchObject([
        {
          action: 'APPLICANT_RESPOND_TO_VIEWING',
          target: { appointmentId: invitation },
        },
      ]);
      expect(projection.applicantInterest).toMatchObject({ state: 'CLOSED' });
      const response = body(
        await applicant.agent
          .get(`/api/v1/applicant/applications/${applicationId}/workspace`)
          .expect(200),
      );
      expect(nested(response, 'attention').pendingActions).toMatchObject([
        { type: 'RESPOND_TO_VIEWING' },
      ]);
      const summary = nested(response, 'viewingSummary');
      expect(summary.nextAction).toBe('APPLICANT_RESPOND_TO_VIEWING');
      expect(nested(summary, 'current')).toMatchObject({
        viewingId: invitation,
        capabilities: { canAccept: true },
      });
      expect(
        nested(nested(summary, 'pendingInterest'), 'capabilities')
          .canSubmitInterest,
      ).toBe(false);
      await applicant.agent
        .patch(path('applicant', `/${invitation}/accept`))
        .send({})
        .expect(200);
      const effects = async () => ({
        activities: await prisma.applicationActivity.count({
          where: { applicationId },
        }),
        outbox: await prisma.outboxEvent.count({ where: { applicationId } }),
        notifications: await prisma.notification.count({
          where: { applicationId },
        }),
      });
      const before = await effects();
      for (const interest of ['STILL_INTERESTED', 'NOT_INTERESTED'])
        await applicant.agent
          .patch(path('applicant', `/${old}/interest`))
          .send({
            interest,
            ...(interest === 'NOT_INTERESTED'
              ? { confirmWithdrawal: true }
              : {}),
          })
          .expect(409);
      expect(await effects()).toEqual(before);
      expect((await application()).status).toBe('ACTIVE');
      expect(
        await prisma.applicationViewingInterest.count({
          where: { viewingId: old },
        }),
      ).toBe(0);
    },
  );

  it('preserves unread messages and stored reply settings across reject/restore while HTTP surfaces recompute permissions', async () => {
    await confirmed();
    const conversation = await prisma.applicationConversation.create({
      data: { applicationId, applicantRepliesEnabled: true },
    });
    const message = await prisma.applicationMessage.create({
      data: {
        conversationId: conversation.id,
        sequence: 1,
        senderType: 'APPLICANT',
        body: 'Unread before rejection',
      },
    });
    const workspace = async () =>
      body(
        await provider.agent
          .get(`/api/v1/provider/applications/${applicationId}/workspace`)
          .expect(200),
      );
    expect(
      nested(await workspace(), 'attention').actionableUnreadMessageCount,
    ).toBe(1);
    await curation().reject(applicationId, provider.id);
    const rejected = await workspace();
    expect(nested(rejected, 'attention').actionableUnreadMessageCount).toBe(0);
    expect(nested(rejected, 'conversationSummary')).toMatchObject({
      applicantRepliesEnabled: true,
      canCurrentUserSend: false,
      sendBlockReason: 'LIFECYCLE_READ_ONLY',
    });
    await releaseCooldown();
    await curation().restore(applicationId, provider.id);
    const restored = await workspace();
    expect(nested(restored, 'attention').actionableUnreadMessageCount).toBe(1);
    expect(nested(restored, 'conversationSummary')).toMatchObject({
      applicantRepliesEnabled: true,
      canCurrentUserSend: true,
    });
    expect(
      (
        await prisma.applicationMessage.findUniqueOrThrow({
          where: { id: message.id },
        })
      ).readAt,
    ).toBeNull();
    expect(await state()).toMatchObject({
      state: 'CLOSED',
      confirmedAppointmentId: null,
    });
  });

  it('still-interested response prevents later timeout and consideration stays a real decision', async () => {
    const id = await complete();
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command(3, { consideration: 'CONTINUE_CONSIDERING' }),
    );
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command(4, { consideration: 'UNDECIDED' }),
    );
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command(5, { interest: 'STILL_INTERESTED' }),
    );
    now = new Date(now.getTime() + 49 * 60 * 60_000);
    expect(
      await runSerializableTransaction(prisma, (tx) =>
        lifecycle().expireViewingInterestWithinTransaction(
          tx,
          applicationId,
          id,
          6,
          now,
        ),
      ),
    ).toBe(false);
    expect((await application()).status).toBe('ACTIVE');
    const decisions = await prisma.applicationActivity.findMany({
      where: { applicationId, type: 'VIEWING_CONSIDERATION_CHANGED' },
    });
    expect(decisions.map((decision) => decision.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerConsideration: 'CONTINUE_CONSIDERING',
        }),
        expect.objectContaining({ providerConsideration: 'UNDECIDED' }),
      ]),
    );
  });

  it('preserves append-only outcome correction and a real deadline when correcting absence to completion', async () => {
    const id = await confirmed();
    now = new Date('2027-01-03T10:30:00Z');
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'PROVIDER' }),
    );
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(3, {
        outcome: 'COMPLETED',
        correctionReason: 'Attendance was confirmed',
      }),
    );
    expect(
      await prisma.applicationViewingOutcome.findMany({
        where: { viewingId: id },
        orderBy: { revision: 'asc' },
      }),
    ).toMatchObject([
      { revision: 1, outcome: 'NO_SHOW', absenceSide: 'PROVIDER' },
      { revision: 2, outcome: 'COMPLETED', absenceSide: null },
    ]);
    expect(
      (
        await prisma.viewingAppointment.findUniqueOrThrow({
          where: { viewingId: id },
        })
      ).interestDeadlineAt,
    ).toEqual(new Date(now.getTime() + 48 * 60 * 60_000));
    expect((await application()).status).toBe('ACTIVE');
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(4, {
        outcome: 'NO_SHOW',
        absenceSide: 'APPLICANT',
        correctionReason: 'Again',
      }),
      409,
    );
  });

  it('a new future invitation does not hide the previous completed viewing interest decision', async () => {
    const id = await complete();
    const proposal = getString(
      await post(
        'provider',
        '/invitations',
        command(3, schedule('2027-01-06T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('applicant', `/proposals/${proposal}/accept`, command(4));
    await post(
      'applicant',
      `/appointments/${id}/interest`,
      command(5, { interest: 'NOT_INTERESTED', confirmWithdrawal: true }),
    );
    expect((await application()).status).toBe('WITHDRAWN');
    expect(
      (
        await prisma.applicationViewing.findUniqueOrThrow({
          where: { id: proposal },
        })
      ).status,
    ).toBe('CANCELLED');
  });

  it('does not roll partial listing rental forward when viewing history fails', async () => {
    await confirmed();
    jest
      .spyOn(app.get(ApplicationActivityService), 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('rental closure history failure'));
    await expect(
      listings().rentListing(listingId, provider.id, {
        selectedApplicationId: applicationId,
      }),
    ).rejects.toThrow('rental closure history failure');
    expect(
      (await prisma.listing.findUniqueOrThrow({ where: { id: listingId } }))
        .status,
    ).toBe('PUBLISHED');
    expect((await application()).status).toBe('ACTIVE');
    expect(await state()).toMatchObject({ state: 'OPEN', revision: 2 });
  });

  it('does not revive a pre-integration terminal legacy commitment during explicit reconciliation', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: 'REJECTED',
        rejectedAt: now,
        publicReason: 'NOT_SELECTED',
      },
    });
    await post('provider', '/reconcile', command(0));
    expect(await state()).toMatchObject({
      mode: 'CURRENT',
      state: 'CLOSED',
      pendingProposalId: null,
      confirmedAppointmentId: null,
    });
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('CANCELLED');
  });

  it('keeps pause/resume reversible without cancelling commitments', async () => {
    const id = await confirmed();
    await listings().pause(listingId, provider.id);
    await listings().resume(listingId, provider.id);
    expect(await state()).toMatchObject({
      state: 'OPEN',
      revision: 2,
      confirmedAppointmentId: id,
    });
  });
});
