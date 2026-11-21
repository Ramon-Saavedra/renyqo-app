import { AuditFixture, auditEvent } from './audit.fixture';
import { assertAuditRuntime } from '../src/audit/persistence/audit-runtime-verifier';
jest.setTimeout(60000);

describe('Audit FORCE RLS and restricted runtime privileges', () => {
  const f = new AuditFixture();
  beforeAll(async () => {
    await f.start();
    await f.append(auditEvent(f.a.workspaceId));
    await f.append(auditEvent(f.b.workspaceId));
  });
  afterAll(() => f.stop());
  it('fails the verifier for an unsafe login or accidental audit grant', async () => {
    await expect(assertAuditRuntime(f.prisma)).rejects.toThrow('unsafe');
    await f.pool.query(`GRANT SELECT ON audit_events TO "${f.runtimeLogin}"`);
    try {
      await expect(assertAuditRuntime(f.runtimePrisma)).rejects.toThrow(
        'unsafe',
      );
    } finally {
      await f.pool.query(
        `REVOKE SELECT ON audit_events FROM "${f.runtimeLogin}"`,
      );
    }
    await f.pool.query(
      'GRANT EXECUTE ON FUNCTION append_audit_event(jsonb) TO PUBLIC',
    );
    try {
      await expect(assertAuditRuntime(f.runtimePrisma)).rejects.toThrow(
        'unsafe',
      );
    } finally {
      await f.pool.query(
        'REVOKE EXECUTE ON FUNCTION append_audit_event(jsonb) FROM PUBLIC',
      );
    }
  });
  it('denies runtime SQL, private append and privileged SET ROLE', async () => {
    await expect(assertAuditRuntime(f.runtimePrisma)).resolves.toBeUndefined();
    for (const sql of [
      'SELECT * FROM audit_events',
      'UPDATE audit_events SET metadata=metadata',
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
      "SELECT append_audit_event('{}'::jsonb)",
      'SET ROLE renyqo_workspace_invariants',
      'SET ROLE renyqo_workspace_owner',
      'ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE audit_events DISABLE TRIGGER ALL',
    ])
      await expect(
        f.sql(f.runtimePool, f.a.workspaceId, (c) => c.query(sql)),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.sql(f.runtimePool, f.a.workspaceId, (c) =>
        c.query('INSERT INTO audit_events(id) VALUES(gen_random_uuid())'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('filters trusted invariant reads and rejects cross-workspace writes', async () => {
    const rows = await f.sql(f.writerPool, f.a.workspaceId, (c) =>
      c.query('SELECT workspace_id FROM audit_events'),
    );
    expect(rows.rows).toEqual([{ workspace_id: f.a.workspaceId }]);
    expect(
      (
        await f.sql(f.writerPool, null, (c) =>
          c.query('SELECT * FROM audit_events'),
        )
      ).rows,
    ).toEqual([]);
    for (const scope of [null, f.a.workspaceId])
      await expect(
        f.sql(f.writerPool, scope, (c) =>
          c.query('SELECT append_audit_event($1::jsonb)', [
            JSON.stringify(auditEvent(f.b.workspaceId)),
          ]),
        ),
      ).rejects.toBeDefined();
  });
  it('uses actual non-owner NOBYPASSRLS logins and cannot turn row security off', async () => {
    for (const pool of [f.writerPool, f.runtimePool]) {
      const result = await pool.query(
        `SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'renyqo_workspace_owner','MEMBER') AS owner FROM pg_roles WHERE rolname=current_user`,
      );
      expect(result.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        owner: false,
      });
    }
    await expect(
      f.sql(f.writerPool, f.a.workspaceId, async (c) => {
        await c.query('SET LOCAL row_security=off');
        await c.query('SELECT * FROM audit_events');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('reuses the same physical connection without retaining tenant context', async () => {
    const first = await f.sql(f.writerPool, f.a.workspaceId, (c) =>
      c.query<{ pid: number; workspace_id: string }>(
        'SELECT pg_backend_pid() AS pid,workspace_id FROM audit_events',
      ),
    );
    const second = await f.sql(f.writerPool, f.b.workspaceId, (c) =>
      c.query<{ pid: number; workspace_id: string }>(
        'SELECT pg_backend_pid() AS pid,workspace_id FROM audit_events',
      ),
    );
    expect(first.rows[0].pid).toBe(second.rows[0].pid);
    expect(second.rows.map((r) => r.workspace_id)).toEqual([f.b.workspaceId]);
    await expect(
      f.sql(f.writerPool, f.a.workspaceId, async (c) => {
        await c.query('SELECT current_workspace_id()');
        throw new Error('rollback scope');
      }),
    ).rejects.toThrow('rollback scope');
    expect(
      (await f.writerPool.query('SELECT * FROM audit_events')).rows,
    ).toEqual([]);
    const c = await f.writerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.workspace_id',$1,false),set_config('app.tenant_xid',pg_current_xact_id()::text,false)`,
        [f.a.workspaceId],
      );
      await c.query('COMMIT');
      expect((await c.query('SELECT * FROM audit_events')).rows).toEqual([]);
    } finally {
      await c.query('RESET app.workspace_id');
      await c.query('RESET app.tenant_xid');
      c.release();
    }
  });
});
