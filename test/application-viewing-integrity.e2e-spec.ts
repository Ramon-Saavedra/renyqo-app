import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

describe('Application viewing PostgreSQL integrity', () => {
  let pool: Pool;
  let client: PoolClient;
  let viewingId: string;
  let applicationId: string;
  let listingId: string;
  let userId: string;

  beforeAll(() => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
      throw new Error('Dedicated E2E database and reset marker required');
    }
    assertSafeE2EDatabaseUrl(url);
    pool = new Pool({ connectionString: url });
  });

  beforeEach(async () => {
    client = await pool.connect();
    viewingId = randomUUID();
    applicationId = randomUUID();
    listingId = randomUUID();
    userId = randomUUID();
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO users (id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES ($1,$2,$3,$4,now(),now(),now())',
      [
        userId,
        'Integrity fixture',
        `${userId}@e2e.renyqo.test`,
        'unusable-test-hash',
      ],
    );
    await client.query(
      'INSERT INTO listings (id,provider_id,display_order,photos,updated_at) VALUES ($1,$2,1,ARRAY[]::text[],now())',
      [listingId, userId],
    );
    await client.query(
      'INSERT INTO applications (id,listing_id,applicant_id,updated_at) VALUES ($1,$2,$3,now())',
      [applicationId, listingId, userId],
    );
    await client.query(
      "INSERT INTO application_viewings (id,application_id,round,starts_at,ends_at,time_zone,request_key,request_hash,updated_at) VALUES ($1,$2,1,now(),now()+interval '30 minutes','Europe/Berlin',$3,$4,now())",
      [viewingId, applicationId, randomUUID(), 'a'.repeat(64)],
    );
    await client.query('COMMIT');
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.query(
      'TRUNCATE application_viewing_interests, application_viewing_outcomes, application_viewings',
    );
    await client.query('DELETE FROM applications WHERE id=$1', [applicationId]);
    await client.query('DELETE FROM listings WHERE id=$1', [listingId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function status(value: string): Promise<void> {
    await client.query(
      'UPDATE application_viewings SET status=$2::"ApplicationViewingStatus", accepted_at=now() WHERE id=$1',
      [viewingId, value],
    );
  }

  async function outcome(revision: number, value: string): Promise<void> {
    await client.query(
      'INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome,correction_reason) VALUES ($1,$2,$3,$4::"ViewingOutcome",$5)',
      [
        randomUUID(),
        viewingId,
        revision,
        value,
        revision === 1 ? null : 'Correction',
      ],
    );
  }

  async function interest(): Promise<void> {
    await client.query(
      "INSERT INTO application_viewing_interests (id,viewing_id,interest) VALUES ($1,$2,'still_interested')",
      [randomUUID(), viewingId],
    );
  }

  async function initial(value: string): Promise<void> {
    await status(value);
    await outcome(1, value);
    await client.query('COMMIT');
    await client.query('BEGIN');
  }

  it.each([
    ['proposed', 'declined_at'],
    ['proposed', 'accepted_at'],
    ['accepted', 'cancelled_at'],
    ['declined', 'cancelled_at'],
    ['cancelled', 'superseded_at'],
    ['superseded', 'declined_at'],
  ])('rejects %s with incompatible %s', async (value, column) => {
    const ownDate =
      value === 'declined'
        ? ', declined_at=now()'
        : value === 'cancelled'
          ? ', cancelled_at=now()'
          : value === 'superseded'
            ? ', superseded_at=now()'
            : '';
    const acceptance = value === 'proposed' ? '' : ', accepted_at=now()';
    await expect(
      client.query(
        `UPDATE application_viewings SET status=$2::"ApplicationViewingStatus", ${column}=now()${ownDate}${acceptance} WHERE id=$1`,
        [viewingId, value],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each([
    ['completed', 'no_show'],
    ['no_show', 'completed'],
  ])(
    'rejects %s with the incompatible %s outcome timestamp',
    async (value, decision) => {
      await status(value);
      await outcome(1, decision);
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it.each([2, 3, 0, -1])(
    'rejects revision %i without revision 1',
    async (revision) => {
      await expect(outcome(revision, 'completed')).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it('rejects an unsupported third revision and gap after revision 1', async () => {
    await initial('completed');
    await expect(outcome(3, 'no_show')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects duplicate contradictory revisions', async () => {
    await initial('completed');
    await expect(outcome(1, 'no_show')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('rejects a correction that repeats the original outcome', async () => {
    await initial('completed');
    await expect(outcome(2, 'completed')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects an effective outcome without a decision', async () => {
    await status('completed');
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects decisions before an effective outcome', async () => {
    await outcome(1, 'completed');
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it.each(['proposed', 'accepted', 'no_show'])(
    'rejects interest on %s',
    async (value) => {
      if (value === 'no_show') await initial(value);
      else if (value === 'accepted') await status(value);
      await interest();
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it.each(['completed', 'no_show'])(
    'commits a valid corrected %s flow with both decisions retained',
    async (value) => {
      await initial(value === 'completed' ? 'no_show' : 'completed');
      await outcome(2, value);
      await status(value);
      if (value === 'completed') await interest();
      await client.query('COMMIT');
      const result = await client.query<{ revision: number; outcome: string }>(
        'SELECT revision,outcome FROM application_viewing_outcomes WHERE viewing_id=$1 ORDER BY revision',
        [viewingId],
      );
      expect(result.rows).toEqual([
        {
          revision: 1,
          outcome: value === 'completed' ? 'no_show' : 'completed',
        },
        { revision: 2, outcome: value },
      ]);
    },
  );

  it('rejects correction to NO_SHOW after interest', async () => {
    await initial('completed');
    await interest();
    await client.query('COMMIT');
    await client.query('BEGIN');
    await outcome(2, 'no_show');
    await status('no_show');
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it.each(['declined', 'change_requested', 'cancelled', 'superseded'])(
    'preserves acceptedAt for valid %s history',
    async (value) => {
      const column =
        value === 'change_requested' ? 'change_requested_at' : `${value}_at`;
      await client.query(
        `UPDATE application_viewings SET status=$2::"ApplicationViewingStatus", accepted_at=now(), ${column}=now() WHERE id=$1`,
        [viewingId, value],
      );
      await client.query('COMMIT');
    },
  );

  it.each([
    'UPDATE application_viewing_outcomes SET outcome=outcome',
    'DELETE FROM application_viewing_outcomes',
  ])('protects append-only history: %s', async (sql) => {
    await initial('completed');
    await expect(
      client.query(`${sql} WHERE viewing_id=$1`, [viewingId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes child writes against stale repeatable-read snapshots', async () => {
    await initial('completed');
    const other = await pool.connect();
    try {
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await other.query('SELECT status FROM application_viewings WHERE id=$1', [
        viewingId,
      ]);
      await interest();
      await client.query('COMMIT');
      await expect(
        other.query(
          "INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome,correction_reason) VALUES ($1,$2,2,'no_show','Correction')",
          [randomUUID(), viewingId],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
  });
});
