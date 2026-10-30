import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('canonical application queue migration', () => {
  const migration = '20261030120000_application_queue_fairness';
  const root = resolve(process.cwd(), 'prisma/migrations');
  const sql = readFileSync(resolve(root, migration, 'migration.sql'), 'utf8');
  let pool: Pool;
  let db: PoolClient;
  let schema: string;
  let listing: string;

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
      throw new Error('Dedicated E2E database required');
    assertSafeE2EDatabaseUrl(url);
    pool = new Pool({ connectionString: url });
    db = await pool.connect();
  });

  beforeEach(async () => {
    schema = `queue_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    for (const name of readdirSync(root).sort()) {
      if (name >= migration || name === 'migration_lock.toml') continue;
      await db.query(
        readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
      );
    }
    const provider = randomUUID();
    listing = randomUUID();
    await db.query(
      `INSERT INTO users(id,name,email,password_hash,role,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Provider',$2,'unused','provider',now(),now(),now())`,
      [provider, `${provider}@queue.test`],
    );
    await db.query(
      `INSERT INTO listings(id,provider_id,display_order,photos,status,updated_at) VALUES($1,$2,1,ARRAY[]::text[],'published',now())`,
      [listing, provider],
    );
  });

  afterEach(async () => {
    await db.query('ROLLBACK');
    await db.query('SET search_path TO public');
    if (!/^queue_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unsafe test schema');
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  afterAll(async () => {
    db?.release();
    await pool?.end();
  });

  async function entry(
    position: number | null,
    createdAt: string,
    status = 'waiting',
    submitted = true,
  ) {
    const id = randomUUID(),
      user = randomUUID();
    await db.query(
      `INSERT INTO users(id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Applicant',$2,'unused',now(),now(),now())`,
      [user, `${user}@queue.test`],
    );
    await db.query(
      `INSERT INTO applications(id,listing_id,applicant_id,status,queue_order,created_at,updated_at) VALUES($1,$2,$3,$4::"ApplicationStatus",COALESCE($5::bigint,nextval(pg_get_serial_sequence('applications','queue_order'))),$6,now())`,
      [id, listing, user, status, position, createdAt],
    );
    if (submitted)
      await db.query(
        `INSERT INTO application_activities(id,application_id,type,actor_type,visibility,payload) VALUES($1,$2,'application_submitted','applicant','applicant','{"initialStatus":"WAITING"}')`,
        [randomUUID(), id],
      );
    return id;
  }
  async function positions() {
    return (
      await db.query<{ id: string; queue_order: string; status: string }>(
        'SELECT id,queue_order,status FROM applications ORDER BY queue_order,id',
      )
    ).rows;
  }

  it('repairs collisions using restoration entry time, preserves statuses and ACTIVE consideration', async () => {
    const restored = await entry(7, '2020-01-01Z');
    const fresh = await entry(7, '2026-03-01Z');
    const oldest = await entry(8, '2026-01-01Z');
    await db.query(
      `INSERT INTO listing_events(id,listing_id,application_id,type,source,payload,occurred_at) VALUES($1,$2,$3,'restored_by_provider','provider','{"toStatus":"WAITING"}','2026-02-01Z')`,
      [randomUUID(), listing, restored],
    );
    await entry(11, '2026-01-01Z', 'active');
    const before = (
      await db.query(
        'SELECT * FROM application_consideration_positions ORDER BY application_id',
      )
    ).rows as unknown[];
    await db.query(sql);
    const rows = await positions();
    expect(rows.filter((r) => r.status === 'waiting').map((r) => r.id)).toEqual(
      [oldest, restored, fresh],
    );
    expect(new Set(rows.map((r) => r.queue_order)).size).toBe(rows.length);
    expect(
      (
        await db.query(
          'SELECT * FROM application_consideration_positions ORDER BY application_id',
        )
      ).rows,
    ).toEqual(before);
    const inserted = await entry(null, '2026-04-01Z');
    const after = await positions();
    expect(after.at(-1)!.id).toBe(inserted);
  });

  it('aborts ambiguous duplicates without repairing statuses or adding uniqueness', async () => {
    await entry(7, '2020-01-01Z', 'waiting', false);
    await entry(7, '2026-01-01Z');
    const before = await positions();
    await expect(db.query(sql)).rejects.toThrow(
      'cannot reconstruct WAITING entry order',
    );
    await db.query('ROLLBACK');
    expect(await positions()).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='applications_queue_order_key'",
          [schema],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('repairs a restoration inversion even if the original collision no longer exists', async () => {
    const restored = await entry(9, '2020-01-01Z');
    const fresh = await entry(8, '2026-03-01Z');
    await db.query(
      `INSERT INTO listing_events(id,listing_id,application_id,type,source,payload,occurred_at) VALUES($1,$2,$3,'restored_by_provider','provider','{"toStatus":"WAITING"}','2026-02-01Z')`,
      [randomUUID(), listing, restored],
    );
    await db.query(sql);
    expect((await positions()).map((r) => r.id)).toEqual([restored, fresh]);
  });

  it('repairs historical duplicates too and rejects future duplicate allocations', async () => {
    await entry(7, '2020-01-01Z', 'withdrawn', false);
    await entry(7, '2021-01-01Z', 'rejected', false);
    await db.query(sql);
    const rows = await positions();
    expect(rows[0].queue_order).not.toBe(rows[1].queue_order);
    await expect(
      entry(Number(rows[0].queue_order), '2026-01-01Z'),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('never rewinds a sequence and permits harmless rollback gaps', async () => {
    await entry(5, '2026-01-01Z');
    await db.query(
      "SELECT setval(pg_get_serial_sequence('applications','queue_order'),10000,true)",
    );
    await db.query(sql);
    await db.query('BEGIN');
    const rolledBack = await entry(null, '2026-02-01Z');
    const consumed = (await positions()).find(
      (r) => r.id === rolledBack,
    )!.queue_order;
    await db.query('ROLLBACK');
    const next = await entry(null, '2026-03-01Z');
    const value = (await positions()).find((r) => r.id === next)!.queue_order;
    expect(BigInt(consumed)).toBeGreaterThan(10000n);
    expect(BigInt(value)).toBeGreaterThan(BigInt(consumed));
  });
});
