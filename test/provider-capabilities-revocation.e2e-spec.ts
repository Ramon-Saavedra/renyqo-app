import { ForbiddenException } from '@nestjs/common';
import { CapabilityFixture } from './provider-capabilities.fixture';
import { deferred } from './provider-authorization.fixture';
import {
  ProviderListingAccess,
  type ProviderActor,
} from '../src/provider-authorization/provider-listing-access';
import type { ProviderOperation } from '../src/provider-authorization/operations/provider-operation';
import { delegateContext } from '../src/provider-authorization/domain/authority-reference';
import * as defaults from '../src/provider-authorization/capabilities/provider-default-capabilities';
import { ApplicationAttentionQueryService } from '../src/application-attention/application-attention-query.service';

jest.setTimeout(60000);
describe('Capability integration with the existing membership revocation fence', () => {
  const f = new CapabilityFixture();
  let w: Awaited<ReturnType<CapabilityFixture['seed']>>;
  let actor: ProviderActor;
  let provider: ProviderListingAccess;
  let index = 0;
  beforeAll(async () => {
    await f.start(6);
    provider = f.app.get(ProviderListingAccess);
  });
  beforeEach(async () => {
    w = await f.seed(index++);
    actor = {
      workspaceId: w.id,
      authority: await f.db.session(w.agents[0].userId),
    };
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.stop());

  it('denies unknown operations without reaching protected production', async () => {
    const produce = jest.fn(() => Promise.resolve('secret'));
    await expect(
      provider.read(
        actor,
        '__proto__' as ProviderOperation,
        w.listingId,
        produce,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(produce).not.toHaveBeenCalled();
  });
  it('invalidates delegated capability authority through the existing membership revision', async () => {
    const context = await provider.read(
      actor,
      'listing.read',
      w.listingId,
      (_tx, current) => Promise.resolve(current),
    );
    const delegated = {
      ...actor,
      authority: delegateContext(context, {
        action: 'listing.read',
        resourceIds: [w.listingId],
      }),
    };
    await f.db.change(w.id, w.agents[0].id, 'SUSPENDED');
    await f.db.change(w.id, w.agents[0].id, 'ACTIVE');
    expect((await f.db.member(w.agents[0].id)).revision).toBe(3);
    await expect(
      provider.read(delegated, 'listing.read', w.listingId, () =>
        Promise.resolve('secret'),
      ),
    ).rejects.toThrow('Membership authority changed');
  });
  it('revalidates authority after async read composition without delivering revoked data', async () => {
    const collected = deferred(),
      release = deferred();
    const pending = provider
      .read(actor, 'document.read', w.listingId, async () => {
        collected.resolve();
        await release.promise;
        return 'protected metadata';
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await collected.promise;
    try {
      await f.db.change(w.id, w.agents[0].id, 'SUSPENDED');
    } finally {
      release.resolve();
    }
    expect((await pending).ok).toBe(false);
  });
  it('rechecks Listing READ for aggregate headers after all application collection', async () => {
    const attention = f.app.get(ApplicationAttentionQueryService);
    const original = attention.batch.bind(attention);
    const effective = defaults.providerDefaultCapabilities;
    const normal = [...effective({ role: 'AGENT', status: 'ACTIVE' })];
    const policy = f.restrictAgents(normal);
    const collected = deferred(),
      release = deferred();
    jest.spyOn(attention, 'batch').mockImplementation(async (...args) => {
      const result = await original(...args);
      collected.resolve();
      await release.promise;
      return result;
    });
    const pending = attention
      .aggregate(actor, 'provider', { filter: 'all', offset: 0, limit: 10 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await collected.promise;
    try {
      policy.mockImplementation((member) =>
        member.role === 'AGENT'
          ? new Set(
              normal.filter((capability) => capability !== 'LISTING_READ'),
            )
          : effective(member),
      );
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenException);
  });
  it('lets an already fenced write commit before suspension can acquire authority locks', async () => {
    const entered = deferred(),
      release = deferred();
    const writer = provider.mutate(
      actor,
      'listing.write',
      w.listingId,
      async (tx) => {
        entered.resolve();
        await release.promise;
        return tx.listing.update({
          where: { id: w.listingId },
          data: { title: 'Fenced capability write' },
        });
      },
    );
    await entered.promise;
    const c = await f.db.pool.connect();
    try {
      const pid = (
        await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      await c.query('BEGIN');
      const suspension = (async () => {
        await f.db.lock(c, w.id);
        await c.query(
          "UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1",
          [w.agents[0].id],
        );
        await c.query('COMMIT');
      })();
      try {
        await f.db.waitBlocked(pid);
      } finally {
        release.resolve();
      }
      expect((await writer).title).toBe('Fenced capability write');
      await suspension;
      expect((await f.db.member(w.agents[0].id)).status).toBe('SUSPENDED');
    } finally {
      release.resolve();
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('denies a write when suspension committed before capability evaluation', async () => {
    await f.db.change(w.id, w.agents[0].id, 'SUSPENDED');
    const mutate = jest.fn(() => Promise.resolve('forbidden'));
    await expect(
      provider.mutate(actor, 'listing.write', w.listingId, mutate),
    ).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });
});
