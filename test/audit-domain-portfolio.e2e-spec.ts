import { randomUUID } from 'node:crypto';
import { AuditContextFixture } from './audit-context.fixture';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { ActorSnapshotCapture } from '../src/member-presentation/actor-snapshot.capture';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AssignmentParticipants } from '../src/listing-assignments/assignment-participants';
import { AssignmentRepository } from '../src/listing-assignments/persistence/assignment.repository';
import { OwnerReassignment } from '../src/listing-assignments/owner-reassignment';
import { AgentTransferRequests } from '../src/listing-assignments/agent-transfer-requests';
import { MockPlanActivation } from '../src/provider-entitlements/adapters/mock-plan-activation';
import { WorkspacePlanCommands } from '../src/provider-entitlements/assignments/workspace-plan.commands';
import { failAudit } from './audit-domain-failure.fixture';

jest.setTimeout(60000);
describe('Required assignment and plan audit under restricted runtime', () => {
  const f = new AuditContextFixture();
  let assign: OwnerReassignment,
    requests: AgentTransferRequests,
    plans: MockPlanActivation;
  const previous = process.env['ENABLE_MOCK_PLAN_ACTIVATION'];
  beforeAll(async () => {
    await f.start();
    const db = f.applicationRuntime as PrismaService;
    const writes = new ProtectedWorkspaceTransactions(
      db,
      f.authorityLocks,
      f.globalAuthority,
      f.resolver,
      new ActorSnapshotCapture(),
    );
    const participants = new AssignmentParticipants(db, f.resolver),
      repository = new AssignmentRepository();
    assign = new OwnerReassignment(participants, writes, repository);
    requests = new AgentTransferRequests(
      db,
      f.resolver,
      participants,
      writes,
      repository,
    );
    plans = new MockPlanActivation(writes, new WorkspacePlanCommands());
    process.env['ENABLE_MOCK_PLAN_ACTIVATION'] = 'true';
  });
  afterAll(async () => {
    await f.stop();
    if (previous === undefined)
      delete process.env['ENABLE_MOCK_PLAN_ACTIVATION'];
    else process.env['ENABLE_MOCK_PLAN_ACTIVATION'] = previous;
  });
  const owner = () => ({ authority: f.owner, workspaceId: f.w.id });
  const agent = () => ({ authority: f.agent, workspaceId: f.w.id });
  const command = async () => ({
    workspaceId: f.w.id,
    listingId: await f.listing(f.w.id, f.w.owner, f.w.agents[0].id),
    targetMembershipId: f.w.agents[1].id,
    expectedListingRevision: 1,
    commandId: randomUUID(),
    correlationId: randomUUID(),
  });
  const events = (commandId: string) =>
    f.prisma.auditEvent.findMany({
      where: { commandId },
      include: { actorIdentity: true },
    });
  it('records the committed reassignment, keeping actor and assignee distinct and history intact', async () => {
    const c = await command();
    await assign.run(f.owner, c);
    const rows = await events(c.commandId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'provider.listing_assignment.changed',
      actorMembershipId: f.w.owner,
      resourceId: c.listingId,
      correlationId: c.correlationId,
      changes: {
        previousMembershipId: f.w.agents[0].id,
        newMembershipId: f.w.agents[1].id,
        reason: 'OWNER_REASSIGNMENT',
      },
    });
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { workspaceId: f.w.id, commandId: c.commandId },
      }),
    ).toBe(1);
    const snapshot = rows[0].actorIdentity?.snapshot;
    await f.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { name: 'Changed current owner name' },
    });
    expect((await events(c.commandId))[0].actorIdentity?.snapshot).toEqual(
      snapshot,
    );
  });
  it('rolls back assignment and its history when required audit persistence fails', async () => {
    const c = await command();
    await failAudit(f.pool, () =>
      expect(assign.run(f.owner, c)).rejects.toBeDefined(),
    );
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: c.listingId } }),
    ).toMatchObject({ responsibleMembershipId: f.w.agents[0].id, revision: 1 });
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { commandId: c.commandId },
      }),
    ).toBe(0);
    expect(await events(c.commandId)).toHaveLength(0);
  });
  it('records transfer request replay once, then OWNER approval and the separate assignment fact', async () => {
    const c = await command(),
      input = { ...c, expiresAt: new Date(Date.now() + 60000) };
    const request = await requests.request(agent(), input);
    await requests.request(agent(), input);
    expect(await events(c.commandId)).toHaveLength(1);
    await requests.respond(owner(), request.id, 'APPROVED');
    const rows = await events(c.commandId);
    expect(rows.map((r) => r.action).sort()).toEqual([
      'provider.listing_assignment.changed',
      'provider.listing_transfer.decided',
      'provider.listing_transfer.requested',
    ]);
    expect(
      rows.find((r) => r.action === 'provider.listing_transfer.requested')
        ?.actorMembershipId,
    ).toBe(f.w.agents[0].id);
    expect(
      rows.find((r) => r.action === 'provider.listing_assignment.changed')
        ?.actorMembershipId,
    ).toBe(f.w.owner);
    await expect(
      requests.respond(owner(), request.id, 'APPROVED'),
    ).rejects.toBeDefined();
    expect(await events(c.commandId)).toHaveLength(3);
  });
  it('denies AGENT/foreign reassignment and emits no success evidence', async () => {
    const c = await command();
    await expect(assign.run(f.agent, c)).rejects.toBeDefined();
    await expect(
      assign.run(f.owner, { ...c, workspaceId: f.foreign.id }),
    ).rejects.toBeDefined();
    expect(await events(c.commandId)).toHaveLength(0);
  });
  it('records real mock plan transition, preserves history, and receipt replay adds no audit', async () => {
    const id = randomUUID();
    await f.prisma.planVersion.create({
      data: {
        id,
        planKey: `audit-${id}`,
        version: 1,
        workspaceKind: 'ORGANIZATION',
        maxListings: 30,
        maxSeats: 30,
        features: [],
      },
    });
    const prior = await f.prisma.workspacePlanAssignment.findUniqueOrThrow({
      where: { workspaceId: f.w.id },
    });
    const input = {
      planVersionId: id,
      expectedRevision: prior.revision,
      expectedOwnershipRevision: 1,
      commandId: randomUUID(),
    };
    await plans.activate(owner(), input);
    await plans.activate(owner(), input);
    const history = await f.prisma.workspacePlanChange.findUniqueOrThrow({
      where: {
        workspaceId_commandId: {
          workspaceId: f.w.id,
          commandId: input.commandId,
        },
      },
    });
    const rows = await events(input.commandId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'provider.plan.assigned',
      sourceEvidenceId: history.id,
      changes: {
        previousPlanVersionId: prior.planVersionId,
        planVersionId: id,
        revision: history.revision,
        source: 'MOCK_DEV',
      },
    });
  });
  it('rolls back plan and immutable history on audit failure', async () => {
    const prior = await f.prisma.workspacePlanAssignment.findUniqueOrThrow({
        where: { workspaceId: f.w.id },
      }),
      id = randomUUID();
    await f.prisma.planVersion.create({
      data: {
        id,
        planKey: `audit-${id}`,
        version: 1,
        workspaceKind: 'ORGANIZATION',
        maxListings: 40,
        maxSeats: 40,
        features: [],
      },
    });
    const input = {
      planVersionId: id,
      expectedRevision: prior.revision,
      expectedOwnershipRevision: 1,
      commandId: randomUUID(),
    };
    await failAudit(f.pool, () =>
      expect(plans.activate(owner(), input)).rejects.toBeDefined(),
    );
    expect(
      await f.prisma.workspacePlanAssignment.findUniqueOrThrow({
        where: { workspaceId: f.w.id },
      }),
    ).toEqual(prior);
    expect(
      await f.prisma.workspacePlanChange.count({
        where: { commandId: input.commandId },
      }),
    ).toBe(0);
  });
  it('competing approvals have one committed assignment and one decision event', async () => {
    const c = await command(),
      request = await requests.request(agent(), {
        ...c,
        expiresAt: new Date(Date.now() + 60000),
      });
    const results = await Promise.allSettled([
      requests.respond(owner(), request.id, 'APPROVED'),
      requests.respond(owner(), request.id, 'APPROVED'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await events(c.commandId)).toHaveLength(3);
    expect(
      await f.prisma.listingAssignmentTransition.count({
        where: { commandId: c.commandId },
      }),
    ).toBe(1);
  });
  it('failed approval audit rolls back both decision and assignment', async () => {
    const c = await command(),
      request = await requests.request(agent(), {
        ...c,
        expiresAt: new Date(Date.now() + 60000),
      });
    await failAudit(f.pool, () =>
      expect(
        requests.respond(owner(), request.id, 'APPROVED'),
      ).rejects.toBeDefined(),
    );
    expect(
      await f.prisma.listingTransferRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({ status: 'REQUESTED', decidedAt: null });
    expect(
      await f.prisma.listing.findUniqueOrThrow({ where: { id: c.listingId } }),
    ).toMatchObject({ responsibleMembershipId: f.w.agents[0].id });
    expect(await events(c.commandId)).toHaveLength(1);
  });
});
