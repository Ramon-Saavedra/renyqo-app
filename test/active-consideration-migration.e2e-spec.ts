import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('ACTIVE consideration migration', () => {
  const migration = '20261024170000_active_consideration_priority';
  const root = resolve(process.cwd(), 'prisma/migrations');
  const schema = `consideration_${randomUUID().replaceAll('-', '')}`;
  const providerId = randomUUID();
  const listingId = randomUUID();
  const ids = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  let pool: Pool;
  let db: PoolClient;
  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
      throw new Error('Dedicated test database required');
    assertSafeE2EDatabaseUrl(url);
    pool = new Pool({ connectionString: url });
    db = await pool.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    for (const name of readdirSync(root).sort()) {
      if (name >= migration || name === 'migration_lock.toml') continue;
      await db.query(
        readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
      );
    }
    await db.query(
      `INSERT INTO users(id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Provider',$2,'unusable',now(),now(),now())`,
      [providerId, `${providerId}@e2e.test`],
    );
    await db.query(
      `INSERT INTO listings(id,provider_id,display_order,photos,status,updated_at) VALUES($1,$2,1,ARRAY[]::text[],'published',now())`,
      [listingId, providerId],
    );
    const times = ['2025-03-01Z', '2025-01-01Z', null, null];
    for (let i = 0; i < 4; i++) {
      const user = randomUUID();
      await db.query(
        `INSERT INTO users(id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Applicant',$2,'unusable',now(),now(),now())`,
        [user, `${user}@e2e.test`],
      );
      await db.query(
        `INSERT INTO applications(id,listing_id,applicant_id,status,active_at,queue_order,updated_at) VALUES($1,$2,$3,$4::"ApplicationStatus",$5, $6,now())`,
        [
          ids[i],
          listingId,
          user,
          i === 3 ? 'waiting' : 'active',
          times[i],
          100 + i,
        ],
      );
    }
    // Incorrect/absent Phase 2 snapshots must not become the live order.
    await db.query(
      `INSERT INTO application_consideration_positions(application_id,listing_id,position) VALUES($1,$4,10),($2,$4,20),($3,$4,999)`,
      [ids[0], ids[1], ids[3], listingId],
    );
  });
  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      db.release();
    }
    if (pool) await pool.end();
  });
  it('rebuilds actual ACTIVE order safely, retains inactive rows and installs durable entry allocation', async () => {
    const before = await db.query(
      'SELECT id,status,active_at,queue_order FROM applications ORDER BY id',
    );
    await db.query(
      readFileSync(resolve(root, migration, 'migration.sql'), 'utf8'),
    );
    await db.query(
      readFileSync(
        resolve(
          root,
          '20261024180000_viewing_attendance_corrections',
          'migration.sql',
        ),
        'utf8',
      ),
    );
    expect(
      (
        await db.query(
          'SELECT id,status,active_at,queue_order FROM applications ORDER BY id',
        )
      ).rows,
    ).toEqual(before.rows);
    const ordered = await db.query<{
      application_id: string;
      position: string;
    }>(
      `SELECT p.application_id,p.position FROM application_consideration_positions p JOIN applications a ON a.id=p.application_id WHERE a.status='active' ORDER BY p.position,a.id`,
    );
    expect(ordered.rows.map((row) => row.application_id)).toEqual([
      ids[1],
      ids[0],
      ids[2],
    ]);
    expect(ordered.rows.every((row) => BigInt(row.position) > 999n)).toBe(true);
    expect(
      (
        await db.query<{ position: string }>(
          'SELECT position FROM application_consideration_positions WHERE application_id=$1',
          [ids[3]],
        )
      ).rows[0].position,
    ).toBe('999');
    expect(
      (
        await db.query<{ count: string }>(
          'SELECT count(*) FROM application_no_show_consequences',
        )
      ).rows[0].count,
    ).toBe('0');
    await db.query(`UPDATE applications SET status='active' WHERE id=$1`, [
      ids[3],
    ]);
    expect(
      (
        await db.query<{ application_id: string }>(
          'SELECT application_id FROM application_consideration_positions ORDER BY position DESC LIMIT 1',
        )
      ).rows[0].application_id,
    ).toBe(ids[3]);
    await db.query(`UPDATE applications SET status='rejected' WHERE id=$1`, [
      ids[1],
    ]);
    await db.query(`UPDATE applications SET status='active' WHERE id=$1`, [
      ids[1],
    ]);
    expect(
      (
        await db.query<{ application_id: string }>(
          'SELECT application_id FROM application_consideration_positions ORDER BY position DESC LIMIT 1',
        )
      ).rows[0].application_id,
    ).toBe(ids[1]);
    const viewingId = randomUUID();
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO application_viewings(id,application_id,round,status,starts_at,ends_at,time_zone,accepted_at,request_key,request_hash,created_at,updated_at) VALUES($1,$2,1,'completed','2025-05-01T10:00Z','2025-05-01T10:30Z','Europe/Berlin','2025-04-01Z',$3,$4,now(),now())`,
      [viewingId, ids[0], randomUUID(), 'a'.repeat(64)],
    );
    await db.query(
      `INSERT INTO application_viewing_outcomes(id,viewing_id,revision,outcome) VALUES($1,$2,1,'completed')`,
      [randomUUID(), viewingId],
    );
    await db.query(
      `INSERT INTO application_viewing_interests(id,viewing_id,interest) VALUES($1,$2,'still_interested')`,
      [randomUUID(), viewingId],
    );
    await db.query('COMMIT');
  });
});
