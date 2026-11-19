import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { memberActorSnapshot } from '../src/member-presentation/actor-snapshot.contract';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { ProviderAuthorizationModule } from '../src/provider-authorization/provider-authorization.module';
import { admitFixtureAgent } from './invitation-admission.fixture';
import { criteriaValues } from '../src/eligibility/listing-criteria-revision.service';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
jest.setTimeout(60000);
describe('Durable member actor evidence', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('does not infer historical presentation for explicitly legacy baseline facts', async () => {
    const id = await f.db.listing(f.w.id, f.w.owner),
      listing = await f.db.prisma.listing.findUniqueOrThrow({ where: { id } });
    const row = await f.db.applicationRuntime.$transaction(
      async (tx) => {
        await installTenantContext(tx, f.w.id);
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${f.w.id}::uuid,1)`;
        return tx.listingCriteriaRevision.create({
          data: {
            listingId: id,
            revision: 1,
            source: 'LEGACY_BASELINE',
            actorUserId: f.w.ownerUser,
            ...criteriaValues(listing),
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    expect(row.actorSnapshot).toBeNull();
  });
  it('captures authenticated OWNER rather than the invited participant and survives profile name/email edits', async () => {
    const owner = await f.owner(),
      account = await f.account(),
      before = await f.db.prisma.user.findUniqueOrThrow({
        where: { id: f.w.ownerUser },
      });
    const { body } = await f.invite(owner, account.email);
    const command =
        await f.db.prisma.workspaceInvitationCommand.findFirstOrThrow({
          where: { invitationId: body.id, kind: 'CREATE' },
        }),
      snapshot = memberActorSnapshot(command.actorSnapshot);
    expect(snapshot).toMatchObject({
      actorUserId: f.w.ownerUser,
      actorMembershipId: f.w.owner,
      actorWorkspaceId: f.w.id,
      actorRoleAtTime: 'OWNER',
      actorDisplayNameAtTime: before.name,
    });
    expect(snapshot?.actorUserId).not.toBe(account.id);
    await f.db.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { name: 'New current name', email: `${randomUUID()}@changed.test` },
    });
    expect(
      (
        await f.db.prisma.workspaceInvitationCommand.findUniqueOrThrow({
          where: {
            workspaceId_commandId: {
              workspaceId: f.w.id,
              commandId: command.commandId,
            },
          },
        })
      ).actorSnapshot,
    ).toEqual(command.actorSnapshot);
    await f.db.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { email: before.email },
    });
  });
  it('records assignment initiator rather than the assigned member and protects snapshot/resource binding', async () => {
    const listing = await f.db.listing(f.w.id, f.w.owner, f.w.agents[0].id);
    const row = await f.db.prisma.listingAssignmentTransition.findFirstOrThrow({
      where: { listingId: listing },
    });
    expect(memberActorSnapshot(row.actorSnapshot)?.actorMembershipId).toBe(
      f.w.owner,
    );
    expect(memberActorSnapshot(row.actorSnapshot)?.actorMembershipId).not.toBe(
      row.newMembershipId,
    );
    await expect(
      f.db.applicationSql(f.w.id, async (c) =>
        c.query(
          `UPDATE listing_assignment_transitions SET actor_snapshot='{}'::jsonb WHERE id=$1`,
          [row.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.db.pool.query(
        `UPDATE listing_assignment_transitions SET actor_snapshot='{}'::jsonb WHERE id=$1`,
        [row.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.db.applicationSql(null, async (c) =>
        c.query('SELECT build_member_actor_snapshot($1,$2,$3)', [
          f.w.id,
          f.w.owner,
          f.w.ownerUser,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('captures role before an atomic foundation ownership swap, preserving colors/IDs', async () => {
    const w = await f.db.workspaceFor(f.w.ownerUser),
      user = await f.db.user(),
      member = await admitFixtureAgent(f.db, w.id, user),
      listing = await f.db.listing(w.id, w.owner, member);
    const before = await f.db.prisma.workspaceMembership.findMany({
        where: { workspaceId: w.id },
        orderBy: { id: 'asc' },
      }),
      authority = await f.db.session(f.w.ownerUser);
    const writes = f.app
      .select(ProviderAuthorizationModule)
      .get(ProtectedWorkspaceTransactions, { strict: true });
    await writes.run(
      authority,
      {
        workspaceId: w.id,
        action: 'test.ownership-foundation',
        resourceIds: [],
        purpose: 'OPERATIONAL',
        requiredRole: 'OWNER',
      },
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: 1,
        membershipIds: [member],
        userIds: [user],
      },
      () => Promise.resolve(),
      async (tx) => {
        await tx.workspaceMembership.update({
          where: { id: w.owner },
          data: { role: 'AGENT', status: 'REMOVED' },
        });
        await tx.workspaceMembership.update({
          where: { id: member },
          data: { role: 'OWNER' },
        });
        await tx.listingEvent.create({
          data: {
            listingId: listing,
            type: 'RESTORED_BY_PROVIDER',
            source: 'PROVIDER',
            actorUserId: f.w.ownerUser,
          },
        });
      },
    );
    const event = await f.db.prisma.listingEvent.findFirstOrThrow({
      where: { listingId: listing },
    });
    expect(memberActorSnapshot(event.actorSnapshot)).toMatchObject({
      actorMembershipId: w.owner,
      actorRoleAtTime: 'OWNER',
    });
    const after = await f.db.prisma.workspaceMembership.findMany({
      where: { workspaceId: w.id },
      orderBy: { id: 'asc' },
    });
    expect(after.map((m) => [m.id, m.displayColor])).toEqual(
      before.map((m) => [m.id, m.displayColor]),
    );
    expect(
      (
        await f.db.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: w.id },
        })
      ).ownershipRevision,
    ).toBe(2);
  });
  it('does not allow caller-supplied JSON or a forged role stamp to replace authoritative facts', async () => {
    const listing = await f.db.listing(f.w.id, f.w.owner);
    await f.db.applicationSql(f.w.id, async (c) => {
      await c.query(
        `INSERT INTO listing_events(id,listing_id,type,source,actor_user_id,actor_snapshot) VALUES($1,$2,'restored_by_provider','provider',$3,'{"actorDisplayNameAtTime":"forged"}')`,
        [randomUUID(), listing, f.w.ownerUser],
      );
    });
    const event = await f.db.prisma.listingEvent.findFirstOrThrow({
      where: { listingId: listing },
    });
    expect(
      memberActorSnapshot(event.actorSnapshot)?.actorDisplayNameAtTime,
    ).not.toBe('forged');
    const agent = f.w.agents[0];
    await expect(
      f.db.applicationSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `SELECT set_config('app.member_actor_snapshot',jsonb_set(build_member_actor_snapshot($1,$2,$3),'{actorRoleAtTime}','"OWNER"')::text,true),set_config('app.member_actor_xid',pg_current_xact_id()::text,true)`,
          [f.w.id, agent.id, agent.userId],
        );
        await c.query(
          `INSERT INTO listing_events(id,listing_id,type,source,actor_user_id) VALUES($1,$2,'restored_by_provider','provider',$3)`,
          [randomUUID(), listing, agent.userId],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
