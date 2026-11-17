import { randomUUID } from 'node:crypto';
import { CapacityFixture } from './workspace-capacity.fixture';
import { SeatReservations } from '../src/provider-entitlements/capacity/seat-reservations';
import { EntitlementResolver } from '../src/provider-entitlements/resolution/entitlement-resolver';
import { WorkspacePlanCommands } from '../src/provider-entitlements/assignments/workspace-plan.commands';
jest.setTimeout(60000);
describe('Internal capacity commands through protected transactions', () => {
  const f = new CapacityFixture(),
    resolver = new EntitlementResolver(),
    reservations = new SeatReservations(resolver),
    plans = new WorkspacePlanCommands();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('reserves/replays/releases capacity without reviving terminal evidence', async () => {
    const w = await f.assigned(2, 2),
      authority = await f.session(w.ownerUser),
      input = {
        workspaceId: w.id,
        id: randomUUID(),
        commandId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
      };
    const run = <T>(mutate: Parameters<typeof f.writes.run<T>>[4]) =>
      f.writes.run(
        authority,
        {
          workspaceId: w.id,
          action: 'test.seat.reserve',
          resourceIds: [],
          purpose: 'OPERATIONAL',
          requiredRole: 'OWNER',
        },
        { kind: 'STRUCTURAL', expectedOwnershipRevision: 1, membershipIds: [] },
        () => Promise.resolve(),
        mutate,
      );
    const first = await run((tx) => reservations.reserve(tx, input));
    const replay = await run((tx) => reservations.reserve(tx, input));
    expect(replay.id).toBe(first.id);
    await expect(
      run((tx) =>
        reservations.reserve(tx, {
          ...input,
          expiresAt: new Date(input.expiresAt.getTime() + 1),
        }),
      ),
    ).rejects.toThrow('SEAT_RESERVATION_CONFLICT');
    const released = await run((tx) =>
      reservations.release(tx, w.id, input.id),
    );
    expect(
      (await run((tx) => reservations.release(tx, w.id, input.id))).releasedAt,
    ).toEqual(released.releasedAt);
    expect(
      (await run((tx) => reservations.reserve(tx, input))).releasedAt,
    ).toEqual(released.releasedAt);
    expect(
      (
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: w.id },
        })
      ).ownershipRevision,
    ).toBe(1);
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: w.owner },
        })
      ).revision,
    ).toBe(1);
  });
  it('rejects stale assignment revisions without changing current plan or history', async () => {
    const w = await f.assigned(),
      authority = await f.session(w.ownerUser),
      next = await f.plan(3),
      count = await f.prisma.workspacePlanChange.count({
        where: { workspaceId: w.id },
      });
    await expect(
      f.writes.run(
        authority,
        {
          workspaceId: w.id,
          action: 'test.plan.change',
          resourceIds: [],
          purpose: 'OPERATIONAL',
          requiredRole: 'OWNER',
        },
        { kind: 'STRUCTURAL', expectedOwnershipRevision: 1, membershipIds: [] },
        () => Promise.resolve(),
        (tx) =>
          plans.assign(tx, {
            workspaceId: w.id,
            actorMembershipId: w.owner,
            planVersionId: next,
            expectedRevision: 1,
            commandId: randomUUID(),
            mode: 'VOLUNTARY',
            source: 'INTERNAL',
          }),
      ),
    ).rejects.toThrow('PLAN_REVISION_CONFLICT');
    expect(
      await f.prisma.workspacePlanChange.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(count);
  });
});
