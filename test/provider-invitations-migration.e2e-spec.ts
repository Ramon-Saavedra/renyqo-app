import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { issueSecret } from '../src/security/opaque-secret';
jest.setTimeout(60000);
describe('Invitation migration preflight and historical expiry', () => {
  const collision = new WorkspaceFixture(),
    expired = new WorkspaceFixture();
  beforeAll(async () => {
    await collision.start('20261117100000_invitation_identity_schema');
    await expired.start('20261116101000_workspace_capacity_guards');
  });
  afterAll(async () => {
    try {
      await collision.stop();
    } finally {
      await expired.stop();
    }
  });
  it('refuses canonical collisions without merging accounts or partially applying the migration', async () => {
    const a = await collision.user(),
      b = await collision.user(),
      email = `${randomUUID()}@identity.test`;
    await collision.prisma.user.update({ where: { id: a }, data: { email } });
    await collision.prisma.user.update({
      where: { id: b },
      data: { email: ` ${email.toUpperCase()} ` },
    });
    const c = await collision.pool.connect();
    try {
      await expect(
        c.query(
          readFileSync(
            'prisma/migrations/20261117100000_invitation_identity_schema/migration.sql',
            'utf8',
          ),
        ),
      ).rejects.toThrow('Resolve canonical email collisions');
      await c.query('ROLLBACK');
      expect(
        (
          await c.query(
            'SELECT count(*)::int n FROM users WHERE id=ANY($1::uuid[])',
            [[a, b]],
          )
        ).rows[0],
      ).toEqual({ n: 2 });
      expect(
        (await c.query(`SELECT to_regclass('workspace_invitations') name`))
          .rows[0],
      ).toEqual({ name: null });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('rejects already-expired migrated evidence and materializes terminal expiry without changing clocks', async () => {
    const owner = await expired.user(),
      user = await expired.user(),
      w = expired.command(owner, 'ORGANIZATION'),
      reservation = randomUUID(),
      invitation = randomUUID(),
      { hash } = issueSecret('workspace-invitation');
    await expired.tx(async (tx) => {
      await installTenantContext(tx, w.workspaceId);
      await expired.establishment.withinTransaction(tx, w);
    });
    // At the actual historical migration boundary reservation guards did not yet
    // exist. Seed historical timestamps, then install every current guard.
    await expired.pool.query(
      `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,created_at,expires_at) VALUES($1,$2,$1,'2020-01-01','2020-01-02')`,
      [reservation, w.workspaceId],
    );
    const migrations = readdirSync('prisma/migrations')
      .sort()
      .filter(
        (n) =>
          n !== 'migration_lock.toml' &&
          n >= '20261116101000_workspace_capacity_guards',
      );
    for (const name of migrations) {
      await expired.pool.query(
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
      if (name === '20261117100000_invitation_identity_schema')
        await expired.pool.query(
          `INSERT INTO workspace_invitations(id,workspace_id,email,created_by_membership_id,reservation_id,token_hash,issuer_membership_revision,issuer_auth_version,ownership_revision,created_at,issued_at,expires_at)
        SELECT $1,$2,email,$3,$4,$5,1,auth_version,1,'2020-01-01','2020-01-01','2020-01-02' FROM users WHERE id=$6`,
          [invitation, w.workspaceId, w.membershipId, reservation, hash, user],
        );
    }
    await expired.prisma.user.update({
      where: { id: user },
      data: { emailVerified: true },
    });
    await expect(
      expired.tx(async (tx) => {
        await installTenantContext(tx, w.workspaceId);
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${w.workspaceId}::uuid,1)`;
        await tx.$queryRaw`SELECT admit_workspace_invitation(${invitation}::uuid,${user}::uuid,${hash},${randomUUID()}::uuid,${randomUUID()}::uuid)`;
      }),
    ).rejects.toThrow('INVITATION_UNAVAILABLE');
    await expired.tx(async (tx) => {
      await installTenantContext(tx, w.workspaceId);
      await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${w.workspaceId}::uuid,1)`;
      await tx.workspaceSeatReservation.update({
        where: { id: reservation },
        data: { releasedAt: new Date() },
      });
      await tx.workspaceInvitation.update({
        where: { id: invitation },
        data: { status: 'EXPIRED' },
      });
    });
    expect(
      (
        await expired.prisma.workspaceInvitation.findUniqueOrThrow({
          where: { id: invitation },
        })
      ).expiredAt,
    ).toEqual(new Date('2020-01-02'));
    expect(
      await expired.prisma.workspaceMembership.count({
        where: { workspaceId: w.workspaceId, userId: user },
      }),
    ).toBe(0);
  });
});
