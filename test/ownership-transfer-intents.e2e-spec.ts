import { MembershipFixture } from './provider-memberships.fixture';

jest.setTimeout(30000);
describe('PostgreSQL dormant ownership transfer intents', () => {
  const f = new MembershipFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  async function confirmed() {
    const w = await f.organization();
    const input = f.intent(w);
    const intent = await f.tx((tx) =>
      f.intents.confirmWithinTransaction(tx, input),
    );
    return { w, input, intent };
  }

  async function respond(
    c: Awaited<ReturnType<typeof confirmed>>,
    response: 'ACCEPTED' | 'CANCELLED' = 'ACCEPTED',
    expectedIntentRevision = 1,
    participant = c.input.targetMembershipId,
  ) {
    return f.tx((tx) =>
      f.intents.respondWithinTransaction(tx, {
        workspaceId: c.w.id,
        intentId: c.intent.id,
        participantMembershipId: participant,
        expectedOwnershipRevision: 1,
        expectedIntentRevision,
        response,
      }),
    );
  }

  it('binds explicit outcome/participants and accepts the same intent without changing authority', async () => {
    const c = await confirmed();
    expect(c.intent).toMatchObject({
      status: 'PENDING_ACCEPTANCE',
      revision: 1,
      outcome: 'DEMOTE_TO_AGENT',
      acceptedAt: null,
    });
    const accepted = await respond(c);
    expect(accepted).toMatchObject({
      status: 'ACCEPTED',
      revision: 2,
      confirmedAt: c.intent.confirmedAt,
    });
    expect(accepted.acceptedAt).toBeInstanceOf(Date);
    expect(await f.member(c.w.owner)).toMatchObject({
      role: 'OWNER',
      revision: 1,
    });
    expect(await f.member(c.w.agents[0].id)).toMatchObject({
      role: 'AGENT',
      revision: 1,
    });
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: c.w.id },
      }),
    ).toMatchObject({ ownershipRevision: 1 });
  });

  it('retries identical confirmation and acceptance idempotently, rejecting changed terms and stale intent revision', async () => {
    const c = await confirmed();
    expect(
      await f.tx((tx) => f.intents.confirmWithinTransaction(tx, c.input)),
    ).toEqual(c.intent);
    await expect(
      f.tx((tx) =>
        f.intents.confirmWithinTransaction(tx, {
          ...c.input,
          outcome: 'REMOVE_MEMBERSHIP',
        }),
      ),
    ).rejects.toThrow('terms differ');
    const accepted = await respond(c);
    expect(await respond(c, 'ACCEPTED', 2)).toEqual(accepted);
    await expect(respond(c)).rejects.toThrow('revision changed');
  });

  it('concurrent identical confirmations create one durable intent', async () => {
    const w = await f.organization();
    const input = f.intent(w);
    const results = await Promise.all(
      [1, 2].map(() =>
        f.tx((tx) => f.intents.confirmWithinTransaction(tx, input)),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(
      await f.prisma.ownershipTransferIntent.count({ where: { id: input.id } }),
    ).toBe(1);
  });

  it('rejects stale expected membership epochs at creation and confirmation retry', async () => {
    const c = await confirmed();
    for (const override of [
      { expectedOwnerMembershipRevision: 2 },
      { expectedTargetMembershipRevision: 2 },
      { expectedOwnershipRevision: 2 },
    ]) {
      await expect(
        f.tx((tx) =>
          f.intents.confirmWithinTransaction(tx, {
            ...f.intent(c.w),
            ...override,
          }),
        ),
      ).rejects.toBeDefined();
    }
    await f.change(c.w.id, c.w.agents[0].id, 'SUSPENDED');
    await expect(
      f.tx((tx) => f.intents.confirmWithinTransaction(tx, c.input)),
    ).rejects.toBeDefined();
  });

  it('only the bound target may accept and only a bound participant may cancel', async () => {
    const c = await confirmed();
    await expect(respond(c, 'ACCEPTED', 1, c.w.owner)).rejects.toThrow(
      'bound participant',
    );
    await expect(respond(c, 'CANCELLED', 1, c.w.agents[1].id)).rejects.toThrow(
      'bound participant',
    );
    expect(await respond(c, 'CANCELLED', 1, c.w.owner)).toMatchObject({
      status: 'CANCELLED',
      revision: 2,
    });
    await expect(respond(c, 'ACCEPTED', 2)).rejects.toBeDefined();
  });

  it('rejects immutable terms, forged evidence timestamps, revision writes and deletion through raw SQL', async () => {
    const c = await confirmed();
    for (const assignment of [
      `outcome='REMOVE_MEMBERSHIP'`,
      `expected_ownership_revision=2`,
      `expected_owner_membership_revision=2`,
      `expected_target_membership_revision=2`,
      `target_membership_id='${c.w.agents[1].id}'`,
      `expires_at=expires_at+interval '1 day'`,
      `confirmed_at=confirmed_at+interval '1 second'`,
      `accepted_at=clock_timestamp()`,
      `revision=revision+1`,
    ]) {
      await expect(
        f.sqlTransaction(async (client) => {
          await f.lock(client, c.w.id);
          await client.query(
            `UPDATE ownership_transfer_intents SET ${assignment} WHERE id=$1`,
            [c.intent.id],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      f.pool.query('DELETE FROM ownership_transfer_intents WHERE id=$1', [
        c.intent.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects cross-workspace participants and PERSONAL transfer intents', async () => {
    const c = await confirmed();
    const other = await f.organization();
    await expect(
      f.tx((tx) =>
        f.intents.confirmWithinTransaction(tx, {
          ...f.intent(c.w),
          targetMembershipId: other.agents[0].id,
        }),
      ),
    ).rejects.toBeDefined();
    const input = f.command(await f.user());
    await f.establish(input);
    await expect(
      f.prisma.ownershipTransferIntent.create({
        data: {
          ...f.intent(c.w),
          workspaceId: input.workspaceId,
          currentOwnerMembershipId: input.membershipId,
          targetMembershipId: input.membershipId,
        },
      }),
    ).rejects.toBeDefined();
  });

  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'target %s invalidates acceptance, including after restoration',
    async (status) => {
      const c = await confirmed();
      await f.change(c.w.id, c.input.targetMembershipId, status);
      await expect(respond(c)).rejects.toBeDefined();
      await f.change(c.w.id, c.input.targetMembershipId, 'ACTIVE');
      await expect(respond(c)).rejects.toBeDefined();
      expect(
        await f.prisma.ownershipTransferIntent.findUniqueOrThrow({
          where: { id: c.intent.id },
        }),
      ).toMatchObject({ status: 'PENDING_ACCEPTANCE', revision: 1 });
    },
  );

  it('owner suspension and global user suspension invalidate acceptance', async () => {
    const a = await confirmed();
    await f.change(a.w.id, a.w.owner, 'SUSPENDED');
    await expect(respond(a)).rejects.toBeDefined();
    const b = await confirmed();
    await f.prisma.user.update({
      where: { id: b.w.agents[0].userId },
      data: { status: 'SUSPENDED' },
    });
    await expect(respond(b)).rejects.toBeDefined();
  });

  it('ownership change invalidates every intent bound to its prior ownership revision', async () => {
    const c = await confirmed();
    await f.sqlTransaction(async (client) => {
      await f.lock(client, c.w.id);
      await client.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [c.w.owner],
      );
      await client.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [c.w.agents[1].id],
      );
    });
    await expect(respond(c)).rejects.toBeDefined();
    await expect(
      f.sqlTransaction(async (client) => {
        await f.lock(client, c.w.id, 2);
        await client.query(
          `UPDATE ownership_transfer_intents SET status='ACCEPTED' WHERE id=$1`,
          [c.intent.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects expired creation and measures expiry after waiting for the workspace lock', async () => {
    const w = await f.organization();
    const input = f.intent(w);
    await expect(
      f.tx((tx) =>
        f.intents.confirmWithinTransaction(tx, {
          ...input,
          expiresAt: new Date(0),
        }),
      ),
    ).rejects.toBeDefined();
    const c = await f.pool.connect();
    try {
      await c.query('BEGIN');
      await f.lock(c, w.id);
      const pending = f.prisma.ownershipTransferIntent.create({
        data: { ...input, expiresAt: new Date(Date.now() + 100) },
      });
      // Force query execution while the parent remains locked; no test clock mock.
      const outcome = Promise.resolve(pending).then(
        () => 'unexpected success',
        () => 'expired',
      );
      await c.query('SELECT pg_sleep(0.25)');
      await c.query('COMMIT');
      expect(await outcome).toBe('expired');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('expired acceptance fails while stale/expired cancellation preserves evidence', async () => {
    const w = await f.organization();
    const input = { ...f.intent(w), expiresAt: new Date(Date.now() + 300) };
    const intent = await f.tx((tx) =>
      f.intents.confirmWithinTransaction(tx, input),
    );
    const c = { w, input, intent };
    await f.pool.query('SELECT pg_sleep(0.35)');
    await expect(respond(c)).rejects.toBeDefined();
    const cancelled = await respond(c, 'CANCELLED');
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      revision: 2,
      expiresAt: input.expiresAt,
      confirmedAt: intent.confirmedAt,
    });
  });

  it('acceptance vs cancellation using the same revision has exactly one winner', async () => {
    const c = await confirmed();
    const results = await Promise.allSettled([
      respond(c),
      respond(c, 'CANCELLED'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await f.prisma.ownershipTransferIntent.findUniqueOrThrow({
          where: { id: c.intent.id },
        })
      ).revision,
    ).toBe(2);
  });

  it('rolls back acceptance evidence and revision with its surrounding transaction', async () => {
    const c = await confirmed();
    await expect(
      f.sqlTransaction(async (client) => {
        await f.lock(client, c.w.id);
        await client.query(
          `UPDATE ownership_transfer_intents SET status='ACCEPTED' WHERE id=$1`,
          [c.intent.id],
        );
        throw new Error('later failure');
      }),
    ).rejects.toThrow('later failure');
    expect(
      await f.prisma.ownershipTransferIntent.findUniqueOrThrow({
        where: { id: c.intent.id },
      }),
    ).toEqual(c.intent);
  });

  it('refuses execution in both private commands and raw SQL until integrations exist', async () => {
    const c = await confirmed();
    await respond(c);
    expect(() => f.intents.execute()).toThrow('integration');
    expect(() => f.membershipLifecycle.remove()).toThrow('integration');
    expect(() => f.membershipLifecycle.reinstate()).toThrow('integration');
    await expect(
      f.sqlTransaction(async (client) => {
        await f.lock(client, c.w.id);
        await client.query(
          `UPDATE ownership_transfer_intents SET status='EXECUTED' WHERE id=$1`,
          [c.intent.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.member(c.w.owner)).toMatchObject({
      role: 'OWNER',
      revision: 1,
    });
  });

  it('fails child-first intent writes without waiting on a held parent', async () => {
    const c = await confirmed();
    const parent = await f.pool.connect();
    try {
      await parent.query('BEGIN');
      await f.lock(parent, c.w.id);
      await expect(
        f.sqlTransaction(async (client) => {
          await client.query(`SET LOCAL lock_timeout='300ms'`);
          await client.query(
            `UPDATE ownership_transfer_intents SET status='ACCEPTED' WHERE id=$1`,
            [c.intent.id],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await parent.query('COMMIT');
    } finally {
      await parent.query('ROLLBACK');
      parent.release();
    }
  });
});
