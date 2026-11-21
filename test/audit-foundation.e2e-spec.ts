import { randomUUID } from 'node:crypto';
import { AuditFixture, auditEvent } from './audit.fixture';
jest.setTimeout(60000);

describe('Audit storage and private append boundary', () => {
  const f = new AuditFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('persists a valid event through a caller-owned tenant transaction', async () => {
    const input = auditEvent(f.a.workspaceId);
    expect(await f.append(input)).toEqual({ id: input.id });
    const row = await f.prisma.auditEvent.findUniqueOrThrow({
      where: { id: input.id },
    });
    expect(row).toMatchObject({
      workspaceId: f.a.workspaceId,
      action: input.action,
      metadata: input.metadata,
      actorKind: 'SYSTEM',
    });
    expect(row.recordedAt).toBeInstanceOf(Date);
  });
  it('validates MEMBER attribution against the selected workspace', async () => {
    const event = {
      ...auditEvent(f.a.workspaceId),
      actor: {
        kind: 'MEMBER' as const,
        userId: f.a.userId,
        membershipId: f.a.membershipId,
      },
    };
    await expect(f.append(event)).resolves.toEqual({ id: event.id });
    await expect(
      f.append({
        ...event,
        id: randomUUID(),
        commandId: randomUUID(),
        actor: { ...event.actor, membershipId: f.b.membershipId },
      }),
    ).rejects.toBeDefined();
  });
  it.each([
    { action: 'listing.changed' },
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { password: 'secret' },
    { metadata: { password: 'secret' } },
    { changes: { status: 'ACTIVE' } },
    { metadata: { activationVersion: 1, unknown: true } },
    { actor: { kind: 'SYSTEM', purpose: 'anything' } },
    { actor: { kind: 'SYSTEM' } },
    { actor: { kind: 'INTEGRATION' } },
    { recordedAt: new Date().toISOString() },
    { metadata: { activationVersion: 1, body: 'x'.repeat(8193) } },
  ])(
    'rejects invalid raw SQL envelopes without trusting TypeScript',
    async (patch) => {
      const event = { ...auditEvent(f.a.workspaceId), ...patch };
      await expect(
        f.sql(f.writerPool, f.a.workspaceId, (c) =>
          c.query('SELECT append_audit_event($1::jsonb)', [
            JSON.stringify(event),
          ]),
        ),
      ).rejects.toBeDefined();
    },
  );
  it('preserves immutable history even under privileged ordinary SQL', async () => {
    const event = auditEvent(f.a.workspaceId);
    await f.append(event);
    for (const sql of [
      'UPDATE audit_events SET metadata=metadata WHERE id=$1',
      'DELETE FROM audit_events WHERE id=$1',
    ])
      await expect(f.pool.query(sql, [event.id])).rejects.toMatchObject({
        code: '23514',
      });
    await expect(
      f.writerPool.query('TRUNCATE audit_events'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rolls back evidence with its outer transaction', async () => {
    const input = auditEvent(f.a.workspaceId);
    await expect(
      f.sql(f.writerPool, input.workspaceId, async (c) => {
        await c.query('SELECT append_audit_event($1::jsonb)', [
          JSON.stringify(input),
        ]);
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(
      await f.prisma.auditEvent.findUnique({ where: { id: input.id } }),
    ).toBeNull();
  });
  it('rejects duplicate command effects without making commandId globally unique', async () => {
    const event = auditEvent(f.a.workspaceId);
    await f.append(event);
    await expect(
      f.append({ ...event, id: randomUUID() }),
    ).rejects.toBeDefined();
    await expect(
      f.append({
        ...event,
        id: randomUUID(),
        workspaceId: f.b.workspaceId,
        resourceId: f.b.workspaceId,
      }),
    ).resolves.toBeDefined();
  });
});
