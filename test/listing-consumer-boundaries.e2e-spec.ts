import { randomUUID } from 'node:crypto';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { deferred } from './provider-authorization.fixture';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProviderListingAccess } from '../src/provider-authorization/provider-listing-access';
import { ApplicantListingAccess } from '../src/listings/applicant-listing-access';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { OwnerReassignment } from '../src/listing-assignments/owner-reassignment';
import { AssignmentParticipants } from '../src/listing-assignments/assignment-participants';
import { AssignmentRepository } from '../src/listing-assignments/persistence/assignment.repository';

jest.setTimeout(60000);
describe('Bounded Listing consumer reads with fresh revocation checks', () => {
  const f = new ListingWorkspaceFixture();
  const workspaces: Awaited<
    ReturnType<ListingWorkspaceFixture['organization']>
  >[] = [];
  let index = 0,
    w: (typeof workspaces)[number],
    id: string;
  let provider: ProviderListingAccess,
    applicant: ApplicantListingAccess,
    reassign: OwnerReassignment;
  beforeAll(async () => {
    await f.start();
    for (let i = 0; i < 6; i++) workspaces.push(await f.organization());
    await f.activateApplication();
    const db = f.applicationRuntime as PrismaService;
    const writes = new ProtectedWorkspaceTransactions(
      db,
      f.authorityLocks,
      f.globalAuthority,
      f.resolver,
    );
    provider = new ProviderListingAccess(
      db,
      f.resolver,
      writes,
      f.globalAuthority,
    );
    applicant = new ApplicantListingAccess(
      db,
      f.globalAuthority,
      f.authorityLocks,
    );
    reassign = new OwnerReassignment(
      new AssignmentParticipants(db, f.resolver),
      writes,
      new AssignmentRepository(),
    );
  });
  beforeEach(async () => {
    w = workspaces[index++];
    id = await f.listing(w.id, w.owner, w.agents[0].id);
  });
  afterAll(() => f.stop());
  it('does not return a projection after membership suspension during result production', async () => {
    const actor = {
      authority: await f.session(w.ownerUser),
      workspaceId: w.id,
    };
    const ready = deferred(),
      release = deferred();
    const result = provider.read(actor, 'test.read', id, async (tx) => {
      const row = await tx.listing.findUniqueOrThrow({
        where: { id },
        select: { title: true },
      });
      ready.resolve();
      await release.promise;
      return row;
    });
    await ready.promise;
    await f.applicationSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
        [w.owner],
      );
    });
    release.resolve();
    await expect(result).rejects.toThrow();
  });
  it('does not return AGENT data after responsibility moves while the membership epoch stays unchanged', async () => {
    const actor = {
      authority: await f.session(w.agents[0].userId),
      workspaceId: w.id,
    };
    const ready = deferred(),
      release = deferred();
    const result = provider.read(actor, 'test.read', id, async (tx) => {
      const row = await tx.listing.findUniqueOrThrow({
        where: { id },
        select: { title: true },
      });
      ready.resolve();
      await release.promise;
      return row;
    });
    await ready.promise;
    await reassign.run(await f.session(w.ownerUser), {
      workspaceId: w.id,
      listingId: id,
      targetMembershipId: w.agents[1].id,
      expectedListingRevision: 1,
      commandId: randomUUID(),
    });
    expect((await f.member(w.agents[0].id)).revision).toBe(1);
    release.resolve();
    await expect(result).rejects.toThrow('Listing not found');
  });
  it('keeps domain reads consistent while permitting a concurrent mutation without authority locks', async () => {
    const actor = {
      authority: await f.session(w.ownerUser),
      workspaceId: w.id,
    };
    const ready = deferred(),
      release = deferred();
    const result = provider.read(actor, 'test.read', id, async (tx) => {
      const first = await tx.listing.findUniqueOrThrow({
        where: { id },
        select: { title: true },
      });
      ready.resolve();
      await release.promise;
      const second = await tx.listing.findUniqueOrThrow({
        where: { id },
        select: { title: true },
      });
      return [first.title, second.title];
    });
    await ready.promise;
    await f.applicationSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(`UPDATE listings SET title='Concurrent edit' WHERE id=$1`, [
        id,
      ]);
    });
    release.resolve();
    expect(await result).toEqual(['Fixture Listing', 'Fixture Listing']);
  });
  it('denies foreign, nonexistent and Listing-only applicant selectors identically', async () => {
    const userId = await f.user(),
      otherId = await f.user();
    const owned = await f.prisma.application.create({
      data: { listingId: id, applicantId: userId, status: 'WAITING' },
    });
    const foreign = await f.prisma.application.create({
      data: { listingId: id, applicantId: otherId, status: 'WAITING' },
    });
    const authority = await f.session(userId);
    expect(
      await applicant.readApplication(
        authority,
        owned.id,
        async () => {},
        (tx) =>
          tx.listing.findUniqueOrThrow({
            where: { id },
            select: { title: true },
          }),
      ),
    ).toEqual({ title: 'Fixture Listing' });
    for (const selector of [foreign.id, randomUUID(), id])
      await expect(
        applicant.readApplication(
          authority,
          selector,
          async () => {},
          () => Promise.resolve('protected'),
        ),
      ).rejects.toThrow('Application not found');
  });
  it('denies applicant results after global revocation during a consistent read', async () => {
    const userId = await f.user();
    const app = await f.prisma.application.create({
      data: { listingId: id, applicantId: userId, status: 'WAITING' },
    });
    const authority = await f.session(userId),
      ready = deferred(),
      release = deferred();
    const result = applicant.readApplication(
      authority,
      app.id,
      async () => {},
      async (tx) => {
        const row = await tx.listing.findUniqueOrThrow({
          where: { id },
          select: { title: true },
        });
        ready.resolve();
        await release.promise;
        return row;
      },
    );
    await ready.promise;
    await f.prisma.user.update({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
    });
    release.resolve();
    await expect(result).rejects.toThrow();
  });
  it('cannot use a dormant listing UUID as public admission authority', async () => {
    const authority = await f.session(await f.user());
    await expect(
      applicant.admit(
        authority,
        id,
        async () => {},
        () => Promise.resolve('protected'),
      ),
    ).rejects.toThrow('Listing not found');
  });
});
