import { randomUUID } from 'node:crypto';
import { WorkspaceFixture } from './provider-workspaces.fixture';

jest.setTimeout(30000);

describe('Provider workspace PostgreSQL invariants', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  it('does not commit an ownerless workspace, including direct SQL establishment', async () => {
    const id = randomUUID();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query(
          `INSERT INTO provider_workspaces(id,kind,display_name) VALUES ($1,'ORGANIZATION','Ownerless')`,
          [id],
        );
        await c.query(
          'INSERT INTO organization_profiles(workspace_id) VALUES ($1)',
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await f.prisma.providerWorkspace.findUnique({ where: { id } }),
    ).toBeNull();
  });

  it('enforces owner uniqueness and refuses a transaction that demotes the only owner', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.establish(input);
    const other = await f.user();
    await expect(
      f.prisma.workspaceMembership.create({
        data: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          userId: other,
          role: 'OWNER',
          displayColor: '#2563EB',
        },
      }),
    ).rejects.toThrow();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1, 1)', [
          input.workspaceId,
        ]);
        await c.query(
          `UPDATE workspace_memberships SET role = 'AGENT' WHERE id = $1`,
          [input.membershipId],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await f.prisma.workspaceMembership.findUnique({
        where: { id: input.membershipId },
      }),
    ).toMatchObject({ role: 'OWNER' });
  });

  it('allows an atomic role swap but never two canonical owners', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.establish(input);
    const other = await f.prisma.workspaceMembership.create({
      data: {
        workspaceId: input.workspaceId,
        userId: await f.user(),
        role: 'AGENT',
        displayColor: '#7C3AED',
      },
    });
    await f.sqlTransaction(async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1, 1)', [
        input.workspaceId,
      ]);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [input.membershipId],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [other.id],
      );
    });
    expect(
      await f.prisma.workspaceMembership.findMany({
        where: { workspaceId: input.workspaceId, role: 'OWNER' },
      }),
    ).toEqual([expect.objectContaining({ id: other.id })]);
    expect(
      await f.prisma.providerWorkspace.findUnique({
        where: { id: input.workspaceId },
      }),
    ).toMatchObject({ ownershipRevision: 2, revision: 2 });
  });

  it('enforces profile-kind consistency and personal membership cardinality at commit', async () => {
    const personal = f.command(await f.user());
    await f.establish(personal);
    await expect(
      f.prisma.organizationProfile.create({
        data: { workspaceId: personal.workspaceId },
      }),
    ).rejects.toThrow();
    await expect(
      f.prisma.workspaceMembership.create({
        data: {
          workspaceId: personal.workspaceId,
          userId: await f.user(),
          role: 'AGENT',
          displayColor: '#7C3AED',
        },
      }),
    ).rejects.toThrow();
    const org = f.command(await f.user(), 'ORGANIZATION');
    await expect(
      f.tx(async (tx) => {
        await f.workspaces.create(tx, {
          id: org.workspaceId,
          kind: 'ORGANIZATION',
          displayName: 'Missing profile',
        });
        await tx.workspaceMembership.create({
          data: {
            id: org.membershipId,
            workspaceId: org.workspaceId,
            userId: org.userId,
            role: 'OWNER',
            displayColor: '#2563EB',
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('rejects immutable identity/color changes and destructive structural deletions', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await expect(
      f.prisma.workspaceMembership.update({
        where: { id: input.membershipId },
        data: { displayColor: '#000000' },
      }),
    ).rejects.toThrow();
    await expect(
      f.prisma.workspaceMembership.update({
        where: { id: input.membershipId },
        data: { userId: await f.user() },
      }),
    ).rejects.toThrow();
    await expect(
      f.prisma.providerWorkspace.update({
        where: { id: input.workspaceId },
        data: { id: randomUUID(), revision: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      f.prisma.workspaceMembership.delete({
        where: { id: input.membershipId },
      }),
    ).rejects.toThrow();
    await expect(
      f.prisma.providerWorkspace.delete({ where: { id: input.workspaceId } }),
    ).rejects.toThrow();
    await expect(
      f.prisma.user.delete({ where: { id: input.userId } }),
    ).rejects.toThrow();
    await expect(
      f.prisma.personalWorkspaceAllocation.deleteMany({
        where: { workspaceId: input.workspaceId },
      }),
    ).rejects.toThrow();
  });
  it('keeps OWNER designation when global account status is suspended', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.establish(input);
    await f.prisma.user.update({
      where: { id: input.userId },
      data: { status: 'SUSPENDED' },
    });
    expect(
      await f.prisma.workspaceMembership.findUnique({
        where: { id: input.membershipId },
      }),
    ).toMatchObject({ role: 'OWNER' });
  });

  it('cannot commit PERSONAL creation/closure without historical allocation evidence', async () => {
    const user = await f.user();
    const id = randomUUID();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query(
          `INSERT INTO provider_workspaces(id,kind,display_name) VALUES ($1,'PERSONAL','No allocation')`,
          [id],
        );
        await c.query(
          `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES ($1,$2,$3,'OWNER','#2563EB')`,
          [randomUUID(), id, user],
        );
        await c.query(
          `UPDATE provider_workspaces SET lifecycle_status='CLOSING', closing_at=CURRENT_TIMESTAMP, revision=2 WHERE id=$1`,
          [id],
        );
        await c.query(
          `UPDATE provider_workspaces SET lifecycle_status='CLOSED', closed_at=CURRENT_TIMESTAMP, revision=3 WHERE id=$1`,
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes competing canonical owner role swaps on the parent row', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.establish(input);
    const targets: string[] = [];
    for (let i = 0; i < 2; i++) {
      const member = await f.prisma.workspaceMembership.create({
        data: {
          workspaceId: input.workspaceId,
          userId: await f.user(),
          role: 'AGENT',
          displayColor: '#7C3AED',
        },
      });
      targets.push(member.id);
    }
    const results = await Promise.allSettled(
      targets.map((target) =>
        f.sqlTransaction(async (c) => {
          await c.query('SELECT lock_workspace_ownership_revision($1, 1)', [
            input.workspaceId,
          ]);
          await c.query(
            `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1 AND role='OWNER'`,
            [input.membershipId],
          );
          await c.query(
            `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
            [target],
          );
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await f.prisma.workspaceMembership.count({
        where: { workspaceId: input.workspaceId, role: 'OWNER' },
      }),
    ).toBe(1);
    expect(
      await f.prisma.providerWorkspace.findUnique({
        where: { id: input.workspaceId },
      }),
    ).toMatchObject({ ownershipRevision: 2 });
  });
});
