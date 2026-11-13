import { randomUUID } from 'node:crypto';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { AssignmentParticipants } from '../src/listing-assignments/assignment-participants';
import { AssignmentRepository } from '../src/listing-assignments/persistence/assignment.repository';
import { OwnerReassignment } from '../src/listing-assignments/owner-reassignment';
import { AgentTransferRequests } from '../src/listing-assignments/agent-transfer-requests';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ProviderActor } from '../src/provider-authorization/provider-listing-access';

jest.setTimeout(60000);
describe('Listing assignment through restricted application login', () => {
  const f = new ListingWorkspaceFixture();
  const organizations: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[] = [];
  let next = 0;
  let w: (typeof organizations)[number];
  let id: string;
  let owner: ProviderActor, source: ProviderActor;
  let reassignment: OwnerReassignment,
    requests: AgentTransferRequests,
    writes: ProtectedWorkspaceTransactions;
  const repository = new AssignmentRepository();
  beforeAll(async () => {
    await f.start();
    for (let i = 0; i < 23; i++) organizations.push(await f.organization());
    await f.activateApplication();
    const db = f.applicationRuntime as PrismaService;
    writes = new ProtectedWorkspaceTransactions(
      db,
      f.authorityLocks,
      f.globalAuthority,
      f.resolver,
    );
    const participants = new AssignmentParticipants(db, f.resolver);
    reassignment = new OwnerReassignment(participants, writes, repository);
    requests = new AgentTransferRequests(
      db,
      f.resolver,
      participants,
      writes,
      repository,
    );
  });
  beforeEach(async () => {
    w = organizations[next++]!;
    if (!w) throw new Error('Missing isolated workspace');
    owner = { authority: await f.session(w.ownerUser), workspaceId: w.id };
    source = {
      authority: await f.session(w.agents[0].userId),
      workspaceId: w.id,
    };
    id = await f.listing(w.id, w.owner, w.agents[0].id);
  });
  afterAll(() => f.stop());
  const command = () => ({
    workspaceId: w.id,
    listingId: id,
    targetMembershipId: w.agents[1].id,
    expectedListingRevision: 1,
    commandId: randomUUID(),
  });
  const request = () =>
    requests.request(source, {
      ...command(),
      expiresAt: new Date(Date.now() + 60000),
    });
  const listing = () => f.prisma.listing.findUniqueOrThrow({ where: { id } });
  async function status(memberId: string, status: string) {
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1`,
        [memberId, status],
      );
    });
  }
  it('OWNER reassigns atomically with revision and append-only evidence', async () => {
    await reassignment.run(owner.authority, command());
    expect(await listing()).toMatchObject({
      responsibleMembershipId: w.agents[1].id,
      revision: 2,
      assignmentSequence: 2,
      createdByMembershipId: w.owner,
    });
    const history = await f.prisma.listingAssignmentTransition.findMany({
      where: { listingId: id },
      orderBy: { sequence: 'asc' },
    });
    expect(history.map((e) => e.reason)).toEqual([
      'INITIAL',
      'OWNER_REASSIGNMENT',
    ]);
    expect(history[1]).toMatchObject({
      previousMembershipId: w.agents[0].id,
      newMembershipId: w.agents[1].id,
      initiatedByMembershipId: w.owner,
    });
  });
  it('same responsible member is an idempotent no-op', async () => {
    await reassignment.run(owner.authority, {
      ...command(),
      targetMembershipId: w.agents[0].id,
    });
    expect(await listing()).toMatchObject({
      revision: 1,
      assignmentSequence: 1,
    });
  });
  it('AGENT cannot directly reassign', async () => {
    await expect(
      reassignment.run(source.authority, command()),
    ).rejects.toThrow();
    expect((await listing()).revision).toBe(1);
  });
  it('rejects foreign workspace target membership', async () => {
    await expect(
      reassignment.run(owner.authority, {
        ...command(),
        targetMembershipId: organizations[0].owner,
      }),
    ).rejects.toThrow();
  });
  it('OWNER approves a request without target acceptance', async () => {
    const intent = await request();
    expect(intent.status).toBe('REQUESTED');
    await requests.respond(owner, intent.id, 'APPROVED');
    expect(await listing()).toMatchObject({
      responsibleMembershipId: w.agents[1].id,
      revision: 2,
    });
    await expect(
      requests.respond(owner, intent.id, 'APPROVED'),
    ).rejects.toThrow();
  });
  it('OWNER rejection preserves responsibility', async () => {
    const intent = await request();
    await requests.respond(owner, intent.id, 'REJECTED');
    expect(await listing()).toMatchObject({
      responsibleMembershipId: w.agents[0].id,
      revision: 1,
    });
  });
  it('source cancellation preserves responsibility', async () => {
    const intent = await request();
    await requests.respond(source, intent.id, 'CANCELLED');
    expect((await listing()).revision).toBe(1);
  });
  it('does not permit two pending requests', async () => {
    await request();
    await expect(request()).rejects.toThrow();
    expect(
      await f.prisma.listingTransferRequest.count({
        where: { listingId: id, status: 'REQUESTED' },
      }),
    ).toBe(1);
  });
  it('stale Listing revision blocks approval', async () => {
    const intent = await request();
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(`UPDATE listings SET title='Changed' WHERE id=$1`, [id]);
    });
    await expect(
      requests.respond(owner, intent.id, 'APPROVED'),
    ).rejects.toThrow();
    expect((await listing()).responsibleMembershipId).toBe(w.agents[0].id);
  });
  it('suspension preserves attribution and makes target assignment ineligible', async () => {
    await status(w.agents[0].id, 'SUSPENDED');
    expect((await listing()).responsibleMembershipId).toBe(w.agents[0].id);
    await status(w.agents[1].id, 'SUSPENDED');
    await expect(
      reassignment.run(owner.authority, command()),
    ).rejects.toThrow();
  });
  it('membership epoch change invalidates approval after resume', async () => {
    const intent = await request();
    await status(w.agents[1].id, 'SUSPENDED');
    await status(w.agents[1].id, 'ACTIVE');
    await expect(
      requests.respond(owner, intent.id, 'APPROVED'),
    ).rejects.toThrow();
  });
  it('removal cannot orphan operational responsibility', async () => {
    await expect(status(w.agents[0].id, 'REMOVED')).rejects.toThrow();
    expect((await f.member(w.agents[0].id)).status).toBe('ACTIVE');
  });
  it('removed target cannot receive responsibility', async () => {
    await status(w.agents[1].id, 'REMOVED');
    await expect(
      reassignment.run(owner.authority, command()),
    ).rejects.toThrow();
  });
  it('atomic reassignment plus removal works and reinstatement does not restore assignment', async () => {
    await writes.run(
      owner.authority,
      {
        workspaceId: w.id,
        action: 'test.member.remove',
        resourceIds: [id],
        purpose: 'OPERATIONAL',
      },
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: 1,
        membershipIds: w.agents.map((m) => m.id),
        userIds: w.agents.map((m) => m.userId),
      },
      async () => {},
      async (tx, context) => {
        await repository.assign(
          tx,
          await repository.lockListing(tx, w.id, id),
          {
            targetMembershipId: w.agents[1].id,
            reason: 'MEMBERSHIP_REMOVAL',
            initiator: context.membershipId,
            commandId: randomUUID(),
          },
        );
        await tx.workspaceMembership.update({
          where: { id: w.agents[0].id },
          data: { status: 'REMOVED' },
        });
      },
    );
    await status(w.agents[0].id, 'ACTIVE');
    expect((await listing()).responsibleMembershipId).toBe(w.agents[1].id);
  });
  it('competing expected-revision reassignments cannot both commit', async () => {
    const results = await Promise.allSettled([
      reassignment.run(owner.authority, command()),
      reassignment.run(owner.authority, {
        ...command(),
        targetMembershipId: w.owner,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await listing()).revision).toBe(2);
  });
  it('raw SQL cannot commit responsibility changes without evidence', async () => {
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          'UPDATE listings SET responsible_membership_id=$2 WHERE id=$1',
          [id, w.agents[1].id],
        );
      }),
    ).rejects.toThrow();
    expect((await listing()).revision).toBe(1);
  });
  it('retirement clears active order and rejects reassignment', async () => {
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(`UPDATE listings SET status='retired' WHERE id=$1`, [id]);
    });
    expect(await listing()).toMatchObject({
      displayOrder: null,
      status: 'RETIRED',
    });
    await expect(
      reassignment.run(owner.authority, {
        ...command(),
        expectedListingRevision: 2,
      }),
    ).rejects.toThrow();
    await status(w.agents[0].id, 'REMOVED');
  });
  it('CLOSING rejects new assignment writes', async () => {
    await f.runtimeSql(w.id, (c) =>
      c.query(
        `UPDATE provider_workspaces SET lifecycle_status='CLOSING',closing_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
        [w.id],
      ),
    );
    await expect(
      reassignment.run(owner.authority, command()),
    ).rejects.toThrow();
  });
  it('expiry rejects approval and preserves durable expired evidence', async () => {
    const intent = await requests.request(source, {
      ...command(),
      expiresAt: new Date(Date.now() + 300),
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(
      requests.respond(owner, intent.id, 'APPROVED'),
    ).rejects.toThrow();
    await f.applicationSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE listing_transfer_requests SET status='EXPIRED' WHERE id=$1`,
        [intent.id],
      );
    });
    expect(
      (
        await f.prisma.listingTransferRequest.findUniqueOrThrow({
          where: { id: intent.id },
        })
      ).status,
    ).toBe('EXPIRED');
    expect((await listing()).revision).toBe(1);
  });
  it('raw SQL cannot change immutable request participants or epochs', async () => {
    const intent = await request();
    await expect(
      f.applicationSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          'UPDATE listing_transfer_requests SET expected_target_revision=2 WHERE id=$1',
          [intent.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('OWNER transfer does not rewrite listing responsibility', async () => {
    await f.applicationSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [w.owner],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [w.agents[1].id],
      );
    });
    expect(await listing()).toMatchObject({
      responsibleMembershipId: w.agents[0].id,
      revision: 1,
    });
    expect(
      (
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: w.id },
        })
      ).ownershipRevision,
    ).toBe(2);
  });
  it('removal racing reassignment cannot commit orphan responsibility', async () => {
    const results = await Promise.allSettled([
      reassignment.run(owner.authority, command()),
      status(w.agents[0].id, 'REMOVED'),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect((await listing()).responsibleMembershipId).toBe(w.agents[1].id);
    expect((await f.member(w.agents[1].id)).status).toBe('ACTIVE');
  });
  it('retirement racing approval permits only one stale-revision winner', async () => {
    const intent = await request();
    const results = await Promise.allSettled([
      requests.respond(owner, intent.id, 'APPROVED'),
      f.applicationSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        const updated = await c.query(
          `UPDATE listings SET status='retired' WHERE id=$1 AND revision=1`,
          [id],
        );
        if (updated.rowCount !== 1) throw new Error('Listing revision changed');
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const current = await listing();
    expect(current.revision).toBe(2);
    if (current.status === 'RETIRED')
      expect(current.responsibleMembershipId).toBe(w.agents[0].id);
    else expect(current.responsibleMembershipId).toBe(w.agents[1].id);
  });
});
