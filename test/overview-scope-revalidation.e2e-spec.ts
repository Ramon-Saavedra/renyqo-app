import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NotFoundException, type INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ProviderActor } from '../src/provider-authorization/provider-listing-access';
import { ProviderListingAccess } from '../src/provider-authorization/provider-listing-access';
import { delegateContext } from '../src/provider-authorization/domain/authority-reference';
import { ProviderApplicationOverviewQueryService } from '../src/application-read-models/provider-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from '../src/application-read-models/application-workspace-query.service';
import { encodeReadModelCursor } from '../src/application-read-models/read-model-cursor';
import { OwnerReassignment } from '../src/listing-assignments/owner-reassignment';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { deferred } from './provider-authorization.fixture';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';

jest.setTimeout(60000);

describe('Overview result scope through restricted runtime', () => {
  const f = new ListingWorkspaceFixture();
  const workspaces: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[] = [];
  let app: INestApplication;
  let overview: ProviderApplicationOverviewQueryService;
  let composition: ApplicationWorkspaceQueryService;
  let workspace: (typeof workspaces)[number];
  let actor: ProviderActor;
  let listingIds: string[];
  let index = 0;

  beforeAll(async () => {
    await f.start();
    for (let i = 0; i < 12; i++) workspaces.push(await f.organization());
    await f.activateApplication();
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
    await app.init();
    overview = app.get(ProviderApplicationOverviewQueryService);
    composition = app.get(ApplicationWorkspaceQueryService);
  });

  beforeEach(async () => {
    workspace = workspaces[index++];
    actor = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.agents[0].userId),
    };
    listingIds = [];
    for (let i = 0; i < 3; i++) {
      listingIds.push(
        await f.listing(workspace.id, workspace.owner, workspace.agents[0].id),
      );
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await f.stop();
    }
  });

  async function reassign(id: string) {
    const before = await f.prisma.listing.findUniqueOrThrow({ where: { id } });
    await app.get(OwnerReassignment).run(await f.session(workspace.ownerUser), {
      workspaceId: workspace.id,
      listingId: id,
      targetMembershipId: workspace.agents[1].id,
      expectedListingRevision: before.revision,
      commandId: randomUUID(),
    });
    expect((await f.member(workspace.agents[0].id)).revision).toBe(1);
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      responsibleMembershipId: workspace.agents[1].id,
      revision: before.revision + 1,
    });
  }

  async function publishFirst() {
    await f.runtimeSql(workspace.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspace.id,
      ]);
      await c.query(
        "UPDATE listings SET status='published', published_at=clock_timestamp() WHERE id=$1",
        [listingIds[0]],
      );
    });
  }

  function pauseAfterCollection() {
    const collected = deferred(),
      release = deferred();
    const original = composition.coverImages.bind(composition);
    jest
      .spyOn(composition, 'coverImages')
      .mockImplementation(async (...args) => {
        const images = await original(...args);
        collected.resolve();
        await release.promise;
        return images;
      });
    return { collected, release };
  }

  it.each(['populated header', 'empty header', 'off-page total'] as const)(
    'does not deliver a stale %s after real responsibility reassignment',
    async (kind) => {
      if (kind === 'populated header') {
        await publishFirst();
        await f.prisma.application.create({
          data: {
            listingId: listingIds[0],
            applicantId: await f.user(),
            status: 'ACTIVE',
            activeAt: new Date(),
          },
        });
      }
      const gate = pauseAfterCollection();
      const pending = overview.overview(actor, { limit: 1 }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await gate.collected.promise;
      try {
        await reassign(
          kind === 'off-page total' ? listingIds[2] : listingIds[0],
        );
      } finally {
        gate.release.resolve();
      }
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(NotFoundException);
    },
  );

  it('preserves OWNER workspace access through the same race', async () => {
    const owner = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.ownerUser),
    };
    const gate = pauseAfterCollection();
    const pending = overview.overview(owner, { limit: 1 });
    await gate.collected.promise;
    try {
      await reassign(listingIds[0]);
    } finally {
      gate.release.resolve();
    }
    expect(await pending).toMatchObject({
      totalCount: 3,
      items: [{ listing: { id: listingIds[0] } }],
    });
  });

  it('preserves the original delegated operation without expanding its authority', async () => {
    const context = await app
      .get(ProviderListingAccess)
      .read(actor, 'listing.overview', undefined, (_tx, current) =>
        Promise.resolve(current),
      );
    const delegated = {
      ...actor,
      authority: delegateContext(context, {
        action: 'listing.overview',
        resourceIds: [],
      }),
    };
    expect(
      (await overview.overview(delegated, { limit: 10 })).items.map(
        (item) => item.listing.id,
      ),
    ).toEqual(listingIds);
    await expect(
      overview.overview(
        {
          ...actor,
          authority: delegateContext(context, {
            action: 'listing.read',
            resourceIds: [],
          }),
        },
        { limit: 10 },
      ),
    ).rejects.toThrow('Outside delegated scope');
  });

  it('revalidates the Application to Listing sources of attention totals', async () => {
    await publishFirst();
    const application = await f.prisma.application.create({
      data: {
        listingId: listingIds[0],
        applicantId: await f.user(),
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    const gate = pauseAfterCollection();
    const pending = overview.overview(actor, { limit: 1 }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await gate.collected.promise;
    try {
      await f.prisma.application.update({
        where: { id: application.id },
        data: { status: 'WAITING' },
      });
    } finally {
      gate.release.resolve();
    }
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.error).toMatchObject({ message: 'Application not found' });
  });

  it('excludes listings reassigned before the protected read and denies direct access', async () => {
    await reassign(listingIds[0]);
    const result = await overview.overview(actor, { limit: 10 });
    expect(result.totalCount).toBe(2);
    expect(result.items.map((item) => item.listing.id)).toEqual(
      listingIds.slice(1),
    );
    await expect(overview.listing(actor, listingIds[0])).rejects.toThrow(
      'Listing not found',
    );
  });

  it('keeps foreign workspace listings and missing IDs indistinguishable', async () => {
    const foreignId = await f.listing(workspaces[0].id, workspaces[0].owner);
    const result = await overview.overview(actor, { limit: 10 });
    expect(result.items.map((item) => item.listing.id)).toEqual(listingIds);
    for (const id of [foreignId, randomUUID()]) {
      await expect(overview.listing(actor, id)).rejects.toThrow(
        'Listing not found',
      );
    }
  });

  it('preserves cursor pagination without including unassigned listings', async () => {
    await reassign(listingIds[1]);
    const first = await overview.overview(actor, { limit: 1 });
    expect(first).toMatchObject({
      totalCount: 2,
      pagination: { hasMore: true },
    });
    const second = await overview.overview(actor, {
      limit: 1,
      cursor: first.pagination.nextCursor!,
    });
    expect(first.items.map((item) => item.listing.id)).toEqual([listingIds[0]]);
    expect(second.items.map((item) => item.listing.id)).toEqual([
      listingIds[2],
    ]);
    expect(second.pagination.hasMore).toBe(false);
  });

  it('allows an empty contributing set and an empty page beyond the cursor', async () => {
    const first = await overview.overview(actor, { limit: 2 });
    const last = await overview.overview(actor, {
      limit: 1,
      cursor: first.pagination.nextCursor!,
    });
    expect(last.items.map((item) => item.listing.id)).toEqual([listingIds[2]]);
    expect(
      await overview.overview(actor, {
        limit: 1,
        cursor: encodeReadModelCursor({
          kind: 'listings',
          id: listingIds[2],
          value: 3,
        }),
      }),
    ).toMatchObject({
      items: [],
      totalCount: 3,
      pagination: { hasMore: false },
    });
    const unassigned = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.agents[1].userId),
    };
    expect(await overview.overview(unassigned, { limit: 10 })).toMatchObject({
      items: [],
      totalCount: 0,
    });
  });

  it('preserves anonymous WAITING counts and historical visibility', async () => {
    const waiting = await f.prisma.application.create({
      data: {
        listingId: listingIds[0],
        applicantId: await f.user(),
        status: 'WAITING',
      },
    });
    const historical = await f.prisma.application.create({
      data: {
        listingId: listingIds[0],
        applicantId: await f.user(),
        status: 'REJECTED',
        activeAt: new Date(Date.now() - 10000),
        rejectedAt: new Date(),
        publicReason: 'NOT_SELECTED',
      },
    });
    const result = await overview.overview(actor, { limit: 10 });
    expect(result.items[0].waitingCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(waiting.id);
    const detail = await overview.listing(actor, listingIds[0]);
    expect(detail.recentExits.map((item) => item.applicationId)).toContain(
      historical.id,
    );
    expect(JSON.stringify(detail)).not.toContain(waiting.id);
  });

  it('excludes RETIRED headers for both roles while preserving OWNER direct history access', async () => {
    await f.runtimeSql(workspace.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspace.id,
      ]);
      await c.query("UPDATE listings SET status='retired' WHERE id=$1", [
        listingIds[0],
      ]);
    });
    const owner = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.ownerUser),
    };
    for (const selected of [actor, owner]) {
      const result = await overview.overview(selected, { limit: 10 });
      expect(result.items.map((item) => item.listing.id)).toEqual(
        listingIds.slice(1),
      );
      expect(result.totalCount).toBe(2);
    }
    await expect(overview.listing(actor, listingIds[0])).rejects.toThrow(
      'Listing not found',
    );
    expect((await overview.listing(owner, listingIds[0])).listing.id).toBe(
      listingIds[0],
    );
  });
});
