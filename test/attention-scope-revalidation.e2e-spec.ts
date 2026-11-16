import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NotFoundException, type INestApplication } from '@nestjs/common';
import type { Prisma } from '../src/generated/prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationListingAccess,
  type ApplicationActor,
} from '../src/listings/application-listing-access';
import type { ApplicantListingPolicy } from '../src/listings/applicant-listing-access';
import {
  ProviderListingAccess,
  type ProviderActor,
} from '../src/provider-authorization/provider-listing-access';
import type { AuthorizationContext } from '../src/provider-authorization/domain/authorization.types';
import { ApplicationAttentionQueryService } from '../src/application-attention/application-attention-query.service';
import { OwnerReassignment } from '../src/listing-assignments/owner-reassignment';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { deferred } from './provider-authorization.fixture';
import { prismaServiceWithSharedPool } from './e2e-prisma-override';

jest.setTimeout(60000);
describe('Attention result scope revalidation through restricted runtime', () => {
  const f = new ListingWorkspaceFixture();
  const workspaces: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[] = [];
  let app: INestApplication;
  let attention: ApplicationAttentionQueryService;
  let access: ApplicationListingAccess;
  let provider: ProviderListingAccess;
  let workspace: (typeof workspaces)[number];
  let actor: ProviderActor;
  let references: { id: string; listingId: string }[];
  let index = 0;

  beforeAll(async () => {
    await f.start();
    for (let i = 0; i < 7; i++) workspaces.push(await f.organization());
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
    attention = app.get(ApplicationAttentionQueryService);
    access = app.get(ApplicationListingAccess);
    provider = app.get(ProviderListingAccess);
  });
  beforeEach(async () => {
    workspace = workspaces[index++];
    actor = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.agents[0].userId),
    };
    references = [];
    for (let i = 0; i < 2; i++) {
      const listingId = await f.listing(
        workspace.id,
        workspace.owner,
        workspace.agents[0].id,
      );
      references.push(
        await f.prisma.application.create({
          data: {
            listingId,
            applicantId: await f.user(),
            status: 'ACTIVE',
            activeAt: new Date(),
          },
          select: { id: true, listingId: true },
        }),
      );
    }
    references.sort((a, b) => a.id.localeCompare(b.id));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await f.stop();
    }
  });

  async function reassign(listingId: string) {
    await app.get(OwnerReassignment).run(await f.session(workspace.ownerUser), {
      workspaceId: workspace.id,
      listingId,
      targetMembershipId: workspace.agents[1].id,
      expectedListingRevision: 1,
      commandId: randomUUID(),
    });
    expect((await f.member(workspace.agents[0].id)).revision).toBe(1);
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: listingId } }),
    ).toMatchObject({
      responsibleMembershipId: workspace.agents[1].id,
      revision: 2,
    });
  }

  function pauseBeforeLaterItem() {
    const collected = deferred(),
      release = deferred();
    const original = access.read.bind(access);
    let firstCollected = false;
    jest.spyOn(access, 'read').mockImplementation(async function <T>(
      selected: ApplicationActor,
      audience: 'provider' | 'applicant',
      id: string,
      policy: ApplicantListingPolicy,
      produce: (
        tx: Prisma.TransactionClient,
        listingId: string,
        context?: AuthorizationContext,
      ) => Promise<T>,
    ): Promise<T> {
      if (id === references[1].id) {
        expect(firstCollected).toBe(true);
        collected.resolve();
        await release.promise;
      }
      const value = await original(selected, audience, id, policy, produce);
      if (id === references[0].id) firstCollected = true;
      return value;
    });
    return { collected, release };
  }

  function read(kind: 'batch' | 'aggregate' | 'actionable', selected = actor) {
    return kind === 'batch'
      ? attention.batch(
          selected,
          'provider',
          references.map((r) => r.id),
        )
      : attention.aggregate(selected, 'provider', {
          filter: kind === 'actionable' ? 'actionable' : 'all',
          offset: 1,
          limit: 1,
        });
  }

  it.each(['batch', 'aggregate', 'actionable'] as const)(
    'does not deliver %s results after an earlier listing is reassigned during later collection',
    async (kind) => {
      const gate = pauseBeforeLaterItem();
      const result = read(kind).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await gate.collected.promise;
      try {
        await reassign(references[0].listingId);
      } finally {
        gate.release.resolve();
      }
      const outcome = await result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(NotFoundException);
    },
  );

  it('revalidates listing headers with no corresponding application item', async () => {
    const emptyListing = await f.listing(
      workspace.id,
      workspace.owner,
      workspace.agents[0].id,
    );
    const collected = deferred(),
      release = deferred();
    const original = provider.read.bind(provider);
    jest.spyOn(provider, 'read').mockImplementation(async function <T>(
      selected: ProviderActor,
      action: string,
      listingId: string | undefined,
      produce: (
        tx: Prisma.TransactionClient,
        context: AuthorizationContext,
      ) => Promise<T>,
    ): Promise<T> {
      if (action === 'attention.batch') {
        collected.resolve();
        await release.promise;
      }
      return original(selected, action, listingId, produce);
    });
    const result = attention
      .aggregate(actor, 'provider', { filter: 'all', offset: 0, limit: 10 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await collected.promise;
    try {
      await reassign(emptyListing);
    } finally {
      release.resolve();
    }
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(NotFoundException);
  });

  it('revalidates an earlier completed batch while a later page is being assembled', async () => {
    const markerListing = await f.listing(
      workspace.id,
      workspace.owner,
      workspace.agents[0].id,
    );
    const markerId = '00000000-0000-4000-8000-000000000001';
    const applicants = Array.from({ length: 199 }, () => randomUUID());
    await f.prisma.user.createMany({
      data: applicants.map((id) => ({
        id,
        name: 'Attention applicant',
        email: `${id}@attention.test`,
        passwordHash: 'not-a-login',
        acceptedTermsAt: new Date(),
        acceptedPrivacyAt: new Date(),
      })),
    });
    await f.prisma.application.createMany({
      data: applicants.map((applicantId, index) => ({
        id: index === 0 ? markerId : randomUUID(),
        listingId: index === 0 ? markerListing : references[1].listingId,
        applicantId,
        status: 'ACTIVE',
        activeAt: new Date(),
      })),
    });
    const collected = deferred(),
      release = deferred();
    const original = attention.batch.bind(attention);
    const batchSizes: number[] = [];
    let calls = 0;
    let markerCollected = false;
    jest.spyOn(attention, 'batch').mockImplementation(async (...args) => {
      if (++calls === 2) {
        expect(markerCollected).toBe(true);
        collected.resolve();
        await release.promise;
      }
      const value = await original(...args);
      batchSizes.push(value.items.length);
      markerCollected ||= value.items.some(
        (item) => item.applicationId === markerId,
      );
      return value;
    });
    const result = attention
      .aggregate(actor, 'provider', { filter: 'all', offset: 200, limit: 1 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await collected.promise;
    try {
      await reassign(markerListing);
    } finally {
      release.resolve();
    }
    const outcome = await result;
    expect(batchSizes).toEqual([200, 1]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(NotFoundException);
  });

  it('preserves OWNER workspace scope through the same responsibility race', async () => {
    const owner = {
      workspaceId: workspace.id,
      authority: await f.session(workspace.ownerUser),
    };
    const gate = pauseBeforeLaterItem();
    const result = read('batch', owner);
    await gate.collected.promise;
    try {
      await reassign(references[0].listingId);
    } finally {
      gate.release.resolve();
    }
    expect((await result).items.map((item) => item.applicationId)).toEqual(
      references.map((r) => r.id),
    );
  });

  it('preserves AGENT scope, WAITING anonymity and visible historical applications', async () => {
    const historical = await f.prisma.application.create({
      data: {
        listingId: references[0].listingId,
        applicantId: await f.user(),
        status: 'REJECTED',
        activeAt: new Date(),
        rejectedAt: new Date(),
        publicReason: 'NOT_SELECTED',
      },
    });
    await f.prisma.application.create({
      data: {
        listingId: references[0].listingId,
        applicantId: await f.user(),
        status: 'WAITING',
      },
    });
    const unassigned = await f.listing(
      workspace.id,
      workspace.owner,
      workspace.agents[1].id,
    );
    await f.prisma.application.create({
      data: {
        listingId: unassigned,
        applicantId: await f.user(),
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    const result = await attention.aggregate(actor, 'provider', {
      filter: 'all',
      offset: 0,
      limit: 10,
    });
    expect(result.items.map((item) => item.applicationId).sort()).toEqual(
      [...references.map((r) => r.id), historical.id].sort(),
    );
    expect(result.listings.map((listing) => listing.listingId).sort()).toEqual(
      references.map((r) => r.listingId).sort(),
    );
  });
});
