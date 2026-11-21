import { AuditWriter } from './audit-writer';
import type { Prisma } from '../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuditEventInput } from '../domain/audit-event';
describe('Private transaction-only audit writer', () => {
  it('uses only the supplied transaction and propagates persistence failure', async () => {
    const workspaceId = randomUUID();
    const input: AuditEventInput = {
      id: randomUUID(),
      workspaceId,
      action: 'audit.ledger.activated',
      schemaVersion: 1,
      actor: { kind: 'SYSTEM', purpose: 'AUDIT_LEDGER_ACTIVATION' },
      resourceType: 'WORKSPACE',
      resourceId: workspaceId,
      occurredAt: new Date().toISOString(),
      source: 'INTERNAL',
      correlationId: randomUUID(),
      commandId: randomUUID(),
      commandScope: 'audit.ledger.activation',
      effectKey: 'activation',
      changes: {},
      metadata: { activationVersion: 1 },
    };
    const query = jest.fn().mockResolvedValue([{ id: input.id }]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    expect(await new AuditWriter().append(tx, input)).toEqual({ id: input.id });
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRejectedValueOnce(new Error('persistence failed'));
    await expect(new AuditWriter().append(tx, input)).rejects.toThrow(
      'persistence failed',
    );
  });
});
