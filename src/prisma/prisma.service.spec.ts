import { PrismaService } from './prisma.service';

describe('Shared Prisma startup boundary', () => {
  it('fails closed on an unsafe production credential at the operational Listing cutover', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const connect = jest.fn().mockResolvedValue(undefined);
    const query = jest
      .fn()
      .mockRejectedValue(new Error('Not a restricted workspace login'));
    try {
      await expect(
        PrismaService.prototype.onModuleInit.call({
          $connect: connect,
          $queryRaw: query,
        }),
      ).rejects.toThrow('Not a restricted workspace login');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
  it('connects with the fully validated application runtime privilege contract', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const connect = jest.fn().mockResolvedValue(undefined);
    const query = jest
      .fn<Promise<{ safe: boolean }[]>, [TemplateStringsArray, ...unknown[]]>()
      .mockResolvedValue([{ safe: true }]);
    try {
      await PrismaService.prototype.onModuleInit.call({
        $connect: connect,
        $queryRaw: query,
      });
      expect(connect).toHaveBeenCalledTimes(1);
      const statements = query.mock.calls.map(([sql]) =>
        sql.join(' ').replace(/\s+/g, ' ').trim(),
      );
      // Each security boundary runs once, in order. A bare query count would
      // miss a duplicated check replacing a required boundary.
      expect(statements).toEqual([
        expect.stringContaining('FROM pg_roles r WHERE r.rolname=current_user'),
        expect.stringContaining(
          "'listings','listing_assignment_transitions','listing_transfer_requests'",
        ),
        expect.stringContaining('AS expected(relation,privilege)'),
        expect.stringContaining(
          "'workspace_plan_assignments','workspace_plan_changes','workspace_seat_reservations'",
        ),
        expect.stringContaining(
          "'workspace_invitations','workspace_invitation_commands'",
        ),
        expect.stringContaining(
          "'audit_events','audit_actor_identities','audit_execution_contexts'",
        ),
      ]);
      expect(query.mock.invocationCallOrder[0]).toBeGreaterThan(
        connect.mock.invocationCallOrder[0],
      );
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
  it('fails closed when the audit runtime privilege boundary is unsafe', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const query = jest.fn((sql: TemplateStringsArray) =>
      Promise.resolve([
        { safe: !sql.join(' ').includes("'audit_actor_identities'") },
      ]),
    );
    try {
      await expect(
        PrismaService.prototype.onModuleInit.call({
          $connect: jest.fn().mockResolvedValue(undefined),
          $queryRaw: query,
        }),
      ).rejects.toThrow('Application audit runtime boundary is unsafe');
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});
