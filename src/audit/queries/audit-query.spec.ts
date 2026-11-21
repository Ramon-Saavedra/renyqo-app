import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { AuditQuery } from './audit-query';
import { AuditSignals } from '../observability/audit-signals';
import type { WorkspaceMembershipResolver } from '../../provider-authorization/workspace-membership.resolver';
import type { PrismaService } from '../../prisma/prisma.service';
describe('Audit query final authorization', () => {
  it('does not release a composed page if final authority revalidation fails', async () => {
    const signals = new AuditSignals();
    const log = jest
      .spyOn(signals, 'report')
      .mockImplementation(() => undefined);
    const read = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }], revision: 4 })
      .mockRejectedValueOnce(
        new ForbiddenException('Workspace authority changed'),
      );
    const query = new AuditQuery(
      {} as PrismaService,
      { read } as unknown as WorkspaceMembershipResolver,
      signals,
    );
    const authority = {
      mode: 'SESSION_BOUND' as const,
      userId: randomUUID(),
      authVersion: 1,
      sessionId: 'server-derived-grant',
    };
    const workspace = randomUUID();
    await expect(
      query.page(authority, workspace, { limit: 1 }),
    ).rejects.toThrow('Workspace authority changed');
    expect(read).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      authority,
      expect.objectContaining({
        workspaceId: workspace,
        requiredRole: 'OWNER',
        expectedMembershipRevision: 4,
      }),
      expect.any(Function),
    );
    expect(log).toHaveBeenCalledWith('AUDIT_QUERY_DENIED');
    log.mockRestore();
  });
});
