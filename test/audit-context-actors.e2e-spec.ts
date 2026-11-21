import {
  AuditContextFixture,
  contextCommand,
  effect,
} from './audit-context.fixture';
import { ApplicantListingAccess } from '../src/listings/applicant-listing-access';
import type { PrismaService } from '../src/prisma/prisma.service';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
jest.setTimeout(60000);
describe('Authenticated audit actor/identity boundary', () => {
  const f = new AuditContextFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('captures canonical MEMBER identity, role/color, command and causality', async () => {
    const command = contextCommand(['first', 'second']);
    const ids = await f.run(command, async (audit) => [
      await audit.append(effect('first')),
      await audit.append(effect('second')),
    ]);
    const rows = await f.prisma.auditEvent.findMany({
      where: { id: { in: ids } },
    });
    expect(rows).toHaveLength(2);
    const member = await f.prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: f.w.owner },
    });
    for (const row of rows)
      expect(row).toMatchObject({
        actorKind: 'MEMBER',
        actorUserId: f.w.ownerUser,
        actorMembershipId: f.w.owner,
        commandId: command.commandId,
        correlationId: command.correlationId,
        causationId: command.causationId,
        source: 'HTTP',
      });
    const snapshot = await f.prisma.auditActorIdentity.findUniqueOrThrow({
      where: { id: rows[0].actorIdentityId! },
    });
    expect(snapshot.snapshot).toMatchObject({
      actorRoleAtTime: 'OWNER',
      actorColorAtTime: member.displayColor,
      actorDisplayNameAtTime: 'Workspace user',
    });
    await f.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { name: 'Changed current name' },
    });
    expect(
      (
        await f.prisma.auditActorIdentity.findUniqueOrThrow({
          where: { id: snapshot.id },
        })
      ).snapshot,
    ).toEqual(snapshot.snapshot);
    expect(await f.prisma.auditExecutionContext.count()).toBe(0);
  });
  it('records USER through its owned application, without provider membership or identity exposure', async () => {
    const user = await f.user(),
      listing = await f.listing(f.w.id, f.w.owner);
    const app = await f.prisma.application.create({
      data: { listingId: listing, applicantId: user },
    });
    const actor = await f.session(user);
    const access = new ApplicantListingAccess(
      f.applicationRuntime as PrismaService,
      f.globalAuthority,
      f.authorityLocks,
    );
    const id = await access.mutateApplication(
      actor,
      app.id,
      () => Promise.resolve(),
      (tx) =>
        f.contexts.user(tx, actor, app.id, contextCommand(), (audit) =>
          audit.append(effect()),
        ),
    );
    const row = await f.prisma.auditEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      actorKind: 'USER',
      actorUserId: user,
      actorMembershipId: null,
    });
    const page = await f.query.page(f.owner, f.w.id, { limit: 100 });
    expect(page.rows.find((r) => r.id === id)?.actor).toEqual({ kind: 'USER' });
  });
  it('rejects missing member context and a mismatching authenticated actor', async () => {
    await expect(
      f.applicationSql(f.w.id, (tx) =>
        tx.query(
          `SELECT open_human_audit_execution($1,$2,1,'SESSION_BOUND',$3,$4,1,NULL,$5::jsonb)`,
          [
            f.w.id,
            f.w.ownerUser,
            f.agent.sessionId,
            f.w.owner,
            JSON.stringify(contextCommand()),
          ],
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.protectedWrites.run(
        f.owner,
        {
          workspaceId: f.w.id,
          action: 'audit.ledger.activated',
          resourceIds: [],
          purpose: 'OPERATIONAL',
        },
        { kind: 'BUSINESS' },
        () => Promise.resolve(),
        (tx) =>
          f.contexts.member(tx, undefined!, contextCommand(), (audit) =>
            audit.append(effect()),
          ),
      ),
    ).rejects.toBeDefined();
  });
  it('keeps SYSTEM explicit and unavailable to ordinary runtime', async () => {
    const command = contextCommand();
    await expect(
      f.applicationSql(f.w.id, (c) =>
        c.query('SELECT open_system_audit_execution($1,$2,$3::jsonb)', [
          f.w.id,
          'AUDIT_LEDGER_ACTIVATION',
          JSON.stringify(command),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await f.tx(async (tx) => {
      await installTenantContext(tx, f.w.id);
      return f.contexts.system(
        tx,
        {
          mode: 'SYSTEM',
          purpose: 'AUDIT_LEDGER_ACTIVATION',
          workspaceId: f.w.id,
          scope: { action: 'audit.ledger.activated', resourceIds: [f.w.id] },
        },
        {
          purpose: 'AUDIT_LEDGER_ACTIVATION',
          authorize: () => Promise.resolve(),
        },
        command,
        (audit) => audit.append(effect()),
      );
    });
    expect(
      await f.prisma.auditEvent.count({
        where: {
          commandId: command.commandId,
          actorKind: 'SYSTEM',
          actorUserId: null,
        },
      }),
    ).toBe(1);
  });
  it('does not activate audit for legacy listing creation', async () => {
    const before = await f.prisma.auditEvent.count();
    await f.listing(f.w.id, f.w.owner);
    expect(await f.prisma.auditEvent.count()).toBe(before);
  });
  it('keeps USER_DELEGATED separate from browser logout and global revocation', async () => {
    const member = f.w.agents[1],
      session = await f.session(member.userId);
    const delegated = {
      mode: 'USER_DELEGATED' as const,
      userId: member.userId,
      authVersion: 1,
      workspaceId: f.w.id,
      membershipId: member.id,
      membershipRevision: 1,
      scope: { action: 'audit.ledger.activated', resourceIds: [f.w.id] },
    };
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: session.sessionId },
    });
    const run = () =>
      f.trustedWrites.run(
        delegated,
        {
          workspaceId: f.w.id,
          action: 'audit.ledger.activated',
          resourceIds: [f.w.id],
          purpose: 'OPERATIONAL',
        },
        { kind: 'BUSINESS' },
        () => Promise.resolve(),
        (tx, ctx) =>
          f.contexts.member(tx, ctx, contextCommand(), (audit) =>
            audit.append(effect()),
          ),
      );
    await expect(
      f.run(contextCommand(), (audit) => audit.append(effect()), delegated),
    ).rejects.toBeDefined();
    const id = await run();
    expect(
      (await f.prisma.auditEvent.findUniqueOrThrow({ where: { id } })).source,
    ).toBe('DOMAIN_WORKER');
    await f.prisma.user.update({
      where: { id: member.userId },
      data: { authVersion: { increment: 1 } },
    });
    await expect(run()).rejects.toBeDefined();
  });
  it('preserves the same historical member identity after removal', async () => {
    const id = await f.run(
      contextCommand(),
      (audit) => audit.append(effect()),
      f.agent,
    );
    const before = await f.prisma.auditEvent.findUniqueOrThrow({
      where: { id },
      include: { actorIdentity: true },
    });
    await f.applicationSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        "UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1",
        [f.w.agents[0].id],
      );
    });
    expect(
      await f.prisma.auditEvent.findUniqueOrThrow({
        where: { id },
        include: { actorIdentity: true },
      }),
    ).toEqual(before);
  });
  it('keeps the pre-mutation OWNER snapshot during an atomic role swap', async () => {
    const target = f.w.agents[1],
      command = contextCommand();
    const id = await f.protectedWrites.run(
      f.owner,
      {
        workspaceId: f.w.id,
        action: 'audit.ledger.activated',
        resourceIds: [],
        purpose: 'OPERATIONAL',
      },
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: 1,
        membershipIds: [target.id],
        userIds: [target.userId],
      },
      () => Promise.resolve(),
      (tx, ctx) =>
        f.contexts.member(tx, ctx, command, async (audit) => {
          await tx.workspaceMembership.update({
            where: { id: f.w.owner },
            data: { role: 'AGENT' },
          });
          await tx.workspaceMembership.update({
            where: { id: target.id },
            data: { role: 'OWNER' },
          });
          return audit.append(effect());
        }),
    );
    const row = await f.prisma.auditEvent.findUniqueOrThrow({
      where: { id },
      include: { actorIdentity: true },
    });
    expect(row.actorIdentity?.snapshot).toMatchObject({
      actorRoleAtTime: 'OWNER',
    });
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: f.w.owner },
        })
      ).role,
    ).toBe('AGENT');
  });
});
