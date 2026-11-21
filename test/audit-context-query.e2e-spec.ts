import {
  AuditContextFixture,
  contextCommand,
  effect,
} from './audit-context.fixture';
import { assertAuditRuntime } from '../src/audit/persistence/audit-runtime-verifier';
import { sqlTenant } from './workspace-tenant.fixture';
jest.setTimeout(60000);
describe('Bounded OWNER audit query and pooled context', () => {
  const f = new AuditContextFixture();
  beforeAll(async () => {
    await f.start();
    await f.run(contextCommand(['a', 'b', 'c']), async (audit) => {
      for (const key of ['a', 'b', 'c']) await audit.append(effect(key));
    });
  });
  afterAll(() => f.stop());
  it('pages deterministically with recordedAt and UUID, without omissions or duplicates', async () => {
    const expected = await f.pool.query<{ id: string }>(
      'SELECT id FROM audit_events WHERE workspace_id=$1 ORDER BY recorded_at DESC,id DESC',
      [f.w.id],
    );
    const first = await f.query.page(f.owner, f.w.id, { limit: 1 });
    const second = await f.query.page(f.owner, f.w.id, {
      limit: 1,
      before: first.next!,
    });
    const third = await f.query.page(f.owner, f.w.id, {
      limit: 1,
      before: second.next!,
    });
    expect(
      [...first.rows, ...second.rows, ...third.rows].map((r) => r.id),
    ).toEqual(expected.rows.map((r) => r.id));
    expect(third.next).toBeNull();
    await expect(f.query.page(f.owner, f.w.id, { limit: 101 })).rejects.toThrow(
      'Invalid audit page',
    );
  });
  it('denies AGENT, foreign workspace and missing SQL tenant context', async () => {
    await expect(
      f.query.page(f.agent, f.w.id, { limit: 10 }),
    ).rejects.toBeDefined();
    await expect(
      f.query.page(f.owner, f.foreign.id, { limit: 10 }),
    ).rejects.toBeDefined();
    await expect(
      f.applicationSql(null, (c) =>
        c.query(
          'SELECT * FROM query_workspace_audit($1,$2,$3,1,10,NULL,NULL)',
          [f.w.id, f.w.ownerUser, f.owner.sessionId],
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.applicationSql(f.w.id, (c) =>
        c.query(
          'SELECT * FROM query_workspace_audit($1,$2,$3,1,10,NULL,NULL)',
          [f.foreign.id, f.w.ownerUser, f.owner.sessionId],
        ),
      ),
    ).rejects.toBeDefined();
  });
  it('keeps raw table access, old append and SYSTEM unavailable to runtime', async () => {
    await expect(
      assertAuditRuntime(f.applicationRuntime),
    ).resolves.toBeUndefined();
    for (const sql of [
      'SELECT * FROM audit_actor_identities',
      'SELECT * FROM audit_execution_contexts',
      'UPDATE audit_actor_identities SET snapshot=snapshot',
      'DELETE FROM audit_actor_identities',
      'TRUNCATE audit_events',
      'INSERT INTO audit_actor_identities(id) VALUES(gen_random_uuid())',
      "SELECT append_audit_event('{}'::jsonb)",
    ])
      await expect(f.applicationPool.query(sql)).rejects.toMatchObject({
        code: '42501',
      });
  });
  it('rejects sensitive keys in identity snapshots even through administrative SQL', async () => {
    await expect(
      f.pool.query(
        `INSERT INTO audit_actor_identities(id,workspace_id,actor_kind,actor_user_id,snapshot,captured_at)
      VALUES(gen_random_uuid(),$1,'USER',$2,$3::jsonb,clock_timestamp())`,
        [
          f.w.id,
          f.w.ownerUser,
          JSON.stringify({
            snapshotVersion: 1,
            actorDisplayNameAtTime: 'Actor',
            capturedAt: new Date().toISOString(),
            password: 'forbidden',
          }),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.pool.query('UPDATE audit_actor_identities SET snapshot=snapshot'),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects accidental PUBLIC execution of the new bounded query helper', async () => {
    const signature =
      'query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid)';
    await f.pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
    try {
      await expect(assertAuditRuntime(f.applicationRuntime)).rejects.toThrow(
        'unsafe',
      );
    } finally {
      await f.pool.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
    }
  });
  it('rejects an old execution on the same physical backend in a later transaction', async () => {
    const c = await f.applicationPool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      await sqlTenant(c, f.w.id);
      const first = await c.query<{ pid: number; id: string }>(
        `SELECT pg_backend_pid() AS pid,open_human_audit_execution($1,$2,1,'SESSION_BOUND',$3,$4,1,NULL,$5::jsonb) AS id`,
        [
          f.w.id,
          f.w.ownerUser,
          f.owner.sessionId,
          f.w.owner,
          JSON.stringify(contextCommand()),
        ],
      );
      id = first.rows[0].id;
      await c.query(
        `SELECT append_context_audit_event($1,'activation','{}','{"activationVersion":1}')`,
        [id],
      );
      await c.query('SELECT close_audit_execution($1)', [id]);
      await c.query('COMMIT');
      await c.query('BEGIN');
      await sqlTenant(c, f.w.id);
      expect(
        (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid,
      ).toBe(first.rows[0].pid);
      await expect(
        c.query(
          `SELECT append_context_audit_event($1,'activation','{}','{"activationVersion":1}')`,
          [id],
        ),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('returns an empty bounded result for a legitimate owner with no events', async () => {
    const authority = await f.session(f.foreign.ownerUser);
    expect(await f.query.page(authority, f.foreign.id, { limit: 10 })).toEqual({
      rows: [],
      next: null,
    });
  });
  it('cannot silently reuse a conflicting historical actor identity', async () => {
    let context = '';
    await expect(
      f.applicationSql(f.w.id, async (c) => {
        const row = await c.query<{ id: string }>(
          `SELECT open_human_audit_execution($1,$2,1,'SESSION_BOUND',$3,$4,1,NULL,$5::jsonb) AS id`,
          [
            f.w.id,
            f.w.ownerUser,
            f.owner.sessionId,
            f.w.owner,
            JSON.stringify(contextCommand()),
          ],
        );
        context = row.rows[0].id;
        // Simulate a UUID collision with independently committed historical data.
        await f.prisma.auditActorIdentity.create({
          data: {
            id: context,
            workspaceId: f.w.id,
            actorKind: 'USER',
            actorUserId: f.agent.userId,
            snapshot: {
              snapshotVersion: 1,
              actorDisplayNameAtTime: 'Another historical actor',
              capturedAt: new Date().toISOString(),
            },
            capturedAt: new Date(),
          },
        });
        await c.query(
          `SELECT append_context_audit_event($1,'activation','{}','{"activationVersion":1}')`,
          [context],
        );
      }),
    ).rejects.toBeDefined();
    expect(
      await f.prisma.auditEvent.count({ where: { actorIdentityId: context } }),
    ).toBe(0);
  });
  it('denies a page after owner suspension without changing OWNER designation', async () => {
    await f.applicationSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        "UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1",
        [f.w.owner],
      );
    });
    await expect(
      f.query.page(f.owner, f.w.id, { limit: 10 }),
    ).rejects.toBeDefined();
  });
});
