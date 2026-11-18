import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
import { issueSecret } from '../src/security/opaque-secret';
import { AuthorityLockRepository } from '../src/provider-authorization/persistence/authority-lock.repository';
import { ProviderAuthorizationModule } from '../src/provider-authorization/provider-authorization.module';
import { deferred } from './provider-authorization.fixture';
jest.setTimeout(60000);
describe('Invitation workspace-root serialization', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  async function waitForBlockedAcceptance() {
    const until = Date.now() + 5000;
    do {
      const {
        rows: [row],
      } = await f.db.pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0) blocked`,
        [f.db.applicationLogin],
      );
      if (row.blocked) return;
    } while (Date.now() < until);
    throw new Error('Expected observed PostgreSQL lock wait');
  }
  for (const action of ['revoke', 'resend'] as const)
    it(`rejects acceptance when ${action} wins an observed root-lock race`, async () => {
      const owner = await f.owner(),
        account = await f.account();
      await f.verify(account);
      const { body } = await f.invite(owner, account.email),
        token = f.secret(account.email, 'invitation');
      const c = await f.db.runtimePool.connect();
      let pending: Promise<{ status: number }> | undefined;
      try {
        await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await sqlTenant(c, f.w.id);
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        pending = account.client
          .post('/api/v1/workspace-invitations/accept')
          .send({ token, commandId: randomUUID() })
          .then((r) => ({ status: r.status }));
        await waitForBlockedAcceptance();
        const row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
          where: { id: body.id },
        });
        if (action === 'revoke') {
          await c.query(
            'UPDATE workspace_seat_reservations SET released_at=clock_timestamp() WHERE id=$1',
            [row.reservationId],
          );
          await c.query(
            `UPDATE workspace_invitations SET status='REVOKED' WHERE id=$1`,
            [row.id],
          );
        } else
          await c.query(
            'UPDATE workspace_invitations SET token_hash=$2 WHERE id=$1',
            [row.id, issueSecret('workspace-invitation').hash],
          );
        await c.query('COMMIT');
        expect((await pending).status).toBe(404);
        expect(
          await f.db.prisma.workspaceMembership.count({
            where: { workspaceId: f.w.id, userId: account.id },
          }),
        ).toBe(0);
      } finally {
        await c.query('ROLLBACK');
        c.release();
        await pending;
      }
    });
  it('simultaneous acceptance has one membership, one released reservation and replay-safe results', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation');
    const commandId = randomUUID();
    const responses = await Promise.all(
      [0, 1].map(() =>
        account.client
          .post('/api/v1/workspace-invitations/accept')
          .send({ token, commandId }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: account.id },
      }),
    ).toBe(1);
    const row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: body.id },
      include: { reservation: true },
    });
    expect(row.reservation.releasedAt).not.toBeNull();
    expect(row.revision).toBe(2);
  });
  it('same-email concurrent create commands admit one logical invitation', async () => {
    const owner = await f.owner(),
      email = `${randomUUID()}@invite.test`;
    const results = await Promise.all(
      [0, 1].map(() =>
        owner
          .post('/api/v1/provider/workspace-invitations')
          .set('x-workspace-id', f.w.id)
          .send({ email, commandId: randomUUID() }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await f.db.prisma.workspaceInvitation.count({
        where: { workspaceId: f.w.id, email, status: 'PENDING' },
      }),
    ).toBe(1);
  });
  it('acceptance may commit first; later revocation cannot rewrite the terminal result', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation');
    const locks = f.app
        .select(ProviderAuthorizationModule)
        .get(AuthorityLockRepository, { strict: true }),
      original = locks.workspace.bind(locks),
      ready = deferred(),
      release = deferred();
    const spy = jest
      .spyOn(locks, 'workspace')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        ready.resolve();
        await release.promise;
      });
    const acceptance = account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .then((r) => r.status);
    let revocation: Promise<number> | undefined;
    try {
      await Promise.race([
        ready.promise,
        acceptance.then(() => {
          throw new Error('Acceptance completed before root barrier');
        }),
      ]);
      revocation = owner
        .post(`/api/v1/provider/workspace-invitations/${body.id}/revoke`)
        .set('x-workspace-id', f.w.id)
        .send({ revision: body.revision, commandId: randomUUID() })
        .then((r) => r.status);
      await waitForBlockedAcceptance();
      release.resolve();
      expect(await acceptance).toBe(200);
      expect(await revocation).toBe(409);
    } finally {
      release.resolve();
      spy.mockRestore();
      await acceptance;
      await revocation;
    }
  });
  it('workspace closing wins before a waiting acceptance and leaves no admitted membership', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    const token = f.secret(account.email, 'invitation');
    const c = await f.db.runtimePool.connect();
    let acceptance: Promise<number> | undefined;
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(c, f.w.id);
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      acceptance = account.client
        .post('/api/v1/workspace-invitations/accept')
        .send({ token, commandId: randomUUID() })
        .then((r) => r.status);
      await waitForBlockedAcceptance();
      await c.query(
        `UPDATE provider_workspaces SET lifecycle_status='CLOSING',closing_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
        [f.w.id],
      );
      await c.query('COMMIT');
      expect(await acceptance).toBe(409);
      expect(
        await f.db.prisma.workspaceMembership.count({
          where: { workspaceId: f.w.id, userId: account.id },
        }),
      ).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await acceptance;
    }
  });
});
