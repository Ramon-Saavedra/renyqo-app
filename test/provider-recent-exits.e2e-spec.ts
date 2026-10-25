import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApplicationsService } from '../src/applications/applications.service';
import { ApplicationActivityService } from '../src/applications/application-activity.service';
import { ProviderRecentExitsQueryService } from '../src/applications/provider-recent-exits-query.service';
import { ProviderApplicationOverviewQueryService } from '../src/application-read-models/provider-application-overview-query.service';
import { ReadModelPageQueryDto } from '../src/application-read-models/dto/read-model-input.dto';
import { ProviderExitedApplicationsResponseDto } from '../src/applications/dto/provider-exited-application-response.dto';
import {
  ApplicationStatus,
  ApplicationRejectionReason,
  ApplicationActivityType,
  ApplicationActivityActorType,
  ApplicationActivityVisibility,
  ListingStatus,
  Role,
} from '../src/generated/prisma/enums';
import type { Application } from '../src/generated/prisma/client';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('Provider recent-exit projection E2E', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let applications: ApplicationsService;
  let activities: ApplicationActivityService;
  let overview: ProviderApplicationOverviewQueryService;
  let recentExits: ProviderRecentExitsQueryService;
  let providerId: string;
  let applicantId: string;
  let listingId: string;
  const userIds: string[] = [];
  const base = new Date('2026-01-01T12:00:00Z');

  function assertDatabase() {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
      throw new Error('Dedicated E2E database and reset marker required');
    assertSafeE2EDatabaseUrl(url);
    return url;
  }

  beforeAll(async () => {
    process.env['DATABASE_URL'] = assertDatabase();
    process.env['NODE_ENV'] = 'test';
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    applications = module.get(ApplicationsService);
    activities = module.get(ApplicationActivityService);
    overview = module.get(ProviderApplicationOverviewQueryService);
    recentExits = module.get(ProviderRecentExitsQueryService);
  });

  async function user(role: Role = Role.APPLICANT) {
    const created = await prisma.user.create({
      data: {
        name: `Recent exit ${randomUUID()}`,
        email: `${randomUUID()}@recent-exits.test`,
        passwordHash: 'e2e-fixture-password-hash',
        role,
        acceptedTermsAt: base,
        acceptedPrivacyAt: base,
      },
    });
    userIds.push(created.id);
    await prisma.applicantProfile.create({
      data: {
        applicantId: created.id,
        householdNetIncome: 3000,
        incomeProofAvailable: true,
        schufaAvailable: true,
        peopleCount: 1,
        adultsCount: 1,
        childrenCount: 0,
        hasPets: false,
        isSmoker: false,
      },
    });
    return created.id;
  }

  beforeEach(async () => {
    providerId = await user(Role.PROVIDER);
    applicantId = await user();
    const listing = await prisma.listing.create({
      data: {
        providerId,
        displayOrder: 1,
        status: ListingStatus.PUBLISHED,
        photos: [],
        title: 'Recent exit listing',
      },
    });
    listingId = listing.id;
  });

  afterEach(async () => {
    if (
      process.env['DATABASE_URL'] !== assertDatabase() ||
      process.env['NODE_ENV'] !== 'test'
    )
      throw new Error('Unsafe E2E cleanup');
    if (listingId) {
      await prisma.$executeRaw`TRUNCATE TABLE application_no_show_consequences, application_consideration_positions`;
      await prisma.application.deleteMany({ where: { listingId } });
      await prisma.listingEvent.deleteMany({ where: { listingId } });
      await prisma.listing.deleteMany({ where: { id: listingId, providerId } });
    }
    await prisma.applicantProfile.deleteMany({
      where: { applicantId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds.length = 0;
  });

  afterAll(async () => {
    if (module) await module.close();
  });

  function attempt(
    overrides: Partial<
      Pick<
        Application,
        | 'id'
        | 'status'
        | 'publicReason'
        | 'createdAt'
        | 'activeAt'
        | 'withdrawnAt'
        | 'rejectedAt'
        | 'applicantId'
      >
    > = {},
  ) {
    return prisma.application.create({
      data: {
        listingId,
        applicantId,
        status: ApplicationStatus.ACTIVE,
        createdAt: base,
        activeAt: base,
        ...overrides,
      },
    });
  }

  async function withdrawalActivity(
    applicationId: string,
    occurredAt = new Date(base.getTime() + 2000),
  ) {
    return activities.append({
      applicationId,
      type: ApplicationActivityType.APPLICATION_WITHDRAWN,
      actorType: ApplicationActivityActorType.APPLICANT,
      visibility: ApplicationActivityVisibility.BOTH,
      occurredAt,
      metadata: {
        fromStatus: ApplicationStatus.WAITING,
        toStatus: ApplicationStatus.WITHDRAWN,
      },
    });
  }

  async function exits() {
    const legacy = new ProviderExitedApplicationsResponseDto(
      await applications.findExitedByListing(listingId, providerId),
    );
    const modern = await overview.listing(providerId, listingId);
    const listings = await overview.overview(
      providerId,
      new ReadModelPageQueryDto(),
    );
    const summary = listings.items.find(
      (item) => item.listing.id === listingId,
    );
    expect(modern.exitedApplicationsCount).toBe(legacy.totalCount);
    expect(summary?.exitedApplicationsCount).toBe(legacy.totalCount);
    expect(
      modern.recentExits.map((item) => ({
        id: item.applicationId,
        status: item.status,
        publicReason: item.publicReason,
        activeAt: item.activeAt,
        exitedAt: item.exitedAt,
        canRestore: item.canRestore,
      })),
    ).toEqual(
      legacy.items.map((item) => ({
        id: item.id,
        status: item.status,
        publicReason: item.publicReason,
        activeAt: item.activeAt,
        exitedAt: item.exitedAt,
        canRestore: item.canRestore,
      })),
    );
    return legacy;
  }

  it.each([ApplicationStatus.ACTIVE, ApplicationStatus.WAITING])(
    'excludes historical withdrawal while a fresh %s attempt exists',
    async (status) => {
      const old = await attempt();
      await applications.withdraw(old.id, applicantId);
      expect((await exits()).items[0]).toMatchObject({
        id: old.id,
        status: ApplicationStatus.WITHDRAWN,
        canRestore: false,
      });
      if (status === ApplicationStatus.WAITING) {
        for (let index = 0; index < 5; index++)
          await attempt({ applicantId: await user() });
      }
      const fresh = await applications.apply(listingId, applicantId);
      expect(fresh.status).toBe(status);
      expect(await exits()).toMatchObject({ items: [], totalCount: 0 });
      await applications.withdraw(fresh.id, applicantId);
      expect((await exits()).items[0]).toMatchObject({
        id: fresh.id,
        status: ApplicationStatus.WITHDRAWN,
        canRestore: false,
      });
      expect((await exits()).totalCount).toBe(1);
    },
  );

  it.each([0, 5])(
    'removes restored attempts and projects later withdrawal with %s occupied slots',
    async (slots) => {
      const old = await applications.apply(listingId, applicantId);
      await applications.reject(old.id, providerId);
      expect((await exits()).items[0].canRestore).toBe(false);
      await expect(
        applications.restore(old.id, providerId),
      ).rejects.toMatchObject({ status: 429 });
      await prisma.listingEvent.updateMany({
        where: { applicationId: old.id },
        data: { occurredAt: new Date(Date.now() - 61_000) },
      });
      expect((await exits()).items[0].canRestore).toBe(true);
      for (let index = 0; index < slots; index++)
        await attempt({ applicantId: await user() });
      const restored = await applications.restore(old.id, providerId);
      expect(restored.status).toBe(
        slots === 0 ? ApplicationStatus.ACTIVE : ApplicationStatus.WAITING,
      );
      expect(await exits()).toMatchObject({ items: [], totalCount: 0 });
      await applications.withdraw(old.id, applicantId);
      const latest = await prisma.applicationActivity.findFirstOrThrow({
        where: {
          applicationId: old.id,
          type: ApplicationActivityType.APPLICATION_WITHDRAWN,
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect((await exits()).items[0]).toMatchObject({
        id: old.id,
        status: ApplicationStatus.WITHDRAWN,
        publicReason: null,
        canRestore: false,
        exitedAt: latest.occurredAt,
      });
      await expect(
        applications.restore(old.id, providerId),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('uses the last rejection after repeated restoration cycles', async () => {
    const entry = await attempt();
    for (let index = 0; index < 2; index++) {
      await applications.reject(entry.id, providerId);
      await prisma.listingEvent.updateMany({
        where: { applicationId: entry.id },
        data: { occurredAt: new Date(Date.now() - 61_000) },
      });
      await applications.restore(entry.id, providerId);
      expect((await exits()).totalCount).toBe(0);
      await prisma.listingEvent.updateMany({
        where: { applicationId: entry.id },
        data: { occurredAt: new Date(Date.now() - 61_000) },
      });
    }
    const rejected = await applications.reject(entry.id, providerId);
    expect((await exits()).items[0]).toMatchObject({
      id: entry.id,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      exitedAt: rejected.rejectedAt,
      canRestore: false,
    });
  });

  it('selects newest attempts before terminal filtering and never revives old exits', async () => {
    const old = await attempt({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      rejectedAt: new Date(base.getTime() + 1000),
    });
    await attempt({
      status: ApplicationStatus.ACCEPTED,
      activeAt: null,
      createdAt: new Date(base.getTime() + 2000),
    });
    expect((await exits()).totalCount).toBe(0);
    await expect(
      applications.restore(old.id, providerId),
    ).rejects.toMatchObject({
      response: { code: 'APPLICATION_ATTEMPT_SUPERSEDED' },
    });
  });

  it('deduplicates by newest attempt with an id tie-breaker and ignores stale rejection dates on withdrawal', async () => {
    const smaller = '00000000-0000-4000-8000-000000000001';
    const larger = '00000000-0000-4000-8000-000000000002';
    await attempt({
      id: smaller,
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      rejectedAt: new Date(base.getTime() + 1000),
    });
    await attempt({
      id: larger,
      status: ApplicationStatus.WITHDRAWN,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      activeAt: null,
      rejectedAt: new Date(base.getTime() + 9000),
      withdrawnAt: new Date(base.getTime() + 2000),
    });
    expect(await exits()).toMatchObject({
      totalCount: 1,
      items: [
        {
          id: larger,
          status: ApplicationStatus.WITHDRAWN,
          publicReason: null,
          exitedAt: new Date(base.getTime() + 2000),
          canRestore: false,
        },
      ],
    });
  });

  it('counts people before limiting and sorts five cards by exit date then id', async () => {
    const entries: Application[] = [];
    for (let index = 0; index < 7; index++) {
      entries.push(
        await attempt({
          applicantId: index === 0 ? applicantId : await user(),
          status: ApplicationStatus.WITHDRAWN,
          withdrawnAt: new Date(
            base.getTime() + (index >= 5 ? 6000 : index * 1000),
          ),
        }),
      );
    }
    const newest = [...entries].sort(
      (a, b) =>
        (b.withdrawnAt?.getTime() ?? 0) - (a.withdrawnAt?.getTime() ?? 0) ||
        b.id.localeCompare(a.id),
    );
    const result = await exits();
    expect(result.totalCount).toBe(7);
    expect(result.items.map((item) => item.id)).toEqual(
      newest.slice(0, 5).map((item) => item.id),
    );
  });

  it('does not expose never-active applicants or identities from contradictory history', async () => {
    const neverActive = await attempt({
      status: ApplicationStatus.WITHDRAWN,
      activeAt: null,
      withdrawnAt: new Date(base.getTime() + 2000),
    });
    await withdrawalActivity(neverActive.id);
    expect((await exits()).items).toEqual([]);
    const contradictory = await attempt({
      applicantId: await user(),
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      rejectedAt: new Date(base.getTime() + 1000),
    });
    await withdrawalActivity(contradictory.id);
    expect((await exits()).items).toEqual([]);
  });

  it('requires an actual exit date and preserves legitimate legacy row fallback', async () => {
    const incomplete = await attempt({ status: ApplicationStatus.WITHDRAWN });
    expect((await exits()).totalCount).toBe(0);
    await prisma.application.update({
      where: { id: incomplete.id },
      data: { withdrawnAt: new Date(base.getTime() + 1000) },
    });
    expect((await exits()).items[0].exitedAt).toEqual(
      new Date(base.getTime() + 1000),
    );
  });

  it('projects an activity-only active entry and withdrawal without row timestamps', async () => {
    const entry = await attempt({
      status: ApplicationStatus.WITHDRAWN,
      activeAt: null,
    });
    await activities.append({
      applicationId: entry.id,
      type: ApplicationActivityType.APPLICATION_SUBMITTED,
      actorType: ApplicationActivityActorType.APPLICANT,
      visibility: ApplicationActivityVisibility.BOTH,
      occurredAt: base,
      metadata: { initialStatus: ApplicationStatus.ACTIVE },
    });
    const exit = await withdrawalActivity(entry.id);
    expect((await exits()).items[0]).toMatchObject({
      id: entry.id,
      activeAt: base,
      exitedAt: exit.occurredAt,
      canRestore: false,
    });
  });

  it.each([
    ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
    ApplicationRejectionReason.LISTING_RENTED,
  ])('does not offer restoration for %s', async (reason) => {
    const entry = await attempt({
      status: ApplicationStatus.REJECTED,
      publicReason: reason,
      rejectedAt: new Date(base.getTime() + 1000),
    });
    expect((await exits()).items[0].canRestore).toBe(false);
    await expect(
      applications.restore(entry.id, providerId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('keeps restore eligibility and listing-state checks authoritative', async () => {
    const entry = await attempt({
      status: ApplicationStatus.REJECTED,
      publicReason: ApplicationRejectionReason.NOT_SELECTED,
      rejectedAt: new Date(base.getTime() + 1000),
    });
    expect((await exits()).items[0].canRestore).toBe(true);
    await prisma.listing.update({
      where: { id: listingId },
      data: { minimumHouseholdNetIncome: 4000 },
    });
    expect((await exits()).items[0].canRestore).toBe(false);
    await expect(
      applications.restore(entry.id, providerId),
    ).rejects.toMatchObject({ status: 422 });
    await prisma.listing.update({
      where: { id: listingId },
      data: { minimumHouseholdNetIncome: null, status: ListingStatus.PAUSED },
    });
    expect((await exits()).items[0].canRestore).toBe(false);
    await expect(
      applications.restore(entry.id, providerId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('enforces owner scope in selection and both read endpoints', async () => {
    await attempt({
      status: ApplicationStatus.WITHDRAWN,
      withdrawnAt: new Date(base.getTime() + 1000),
    });
    const foreign = await user(Role.PROVIDER);
    await expect(
      applications.findExitedByListing(listingId, foreign),
    ).rejects.toMatchObject({ status: 404 });
    await expect(overview.listing(foreign, listingId)).rejects.toMatchObject({
      status: 404,
    });
    const result = await prisma.$transaction(
      (tx) => recentExits.select(tx, foreign, [listingId]),
      { isolationLevel: 'RepeatableRead' },
    );
    expect(result.get(listingId)).toEqual({ items: [], totalCount: 0 });
    const serialized = JSON.stringify(await exits());
    expect(serialized).not.toMatch(
      /applicantId|householdNetIncome|passwordHash|queueOrder|schufaAvailable/,
    );
  });

  it('keeps counts and cards in the same snapshot during concurrent re-entry', async () => {
    const old = await attempt();
    await applications.withdraw(old.id, applicantId);
    await prisma.$transaction(
      async (tx) => {
        const selection = await recentExits.select(tx, providerId, [listingId]);
        await applications.apply(listingId, applicantId);
        const rows = await recentExits.cards(
          tx,
          providerId,
          selection.get(listingId)?.items ?? [],
          new Date(),
        );
        expect(selection.get(listingId)?.totalCount).toBe(1);
        expect(rows.map((item) => item.id)).toEqual([old.id]);
      },
      { isolationLevel: 'RepeatableRead' },
    );
    expect((await exits()).totalCount).toBe(0);
  });
});
