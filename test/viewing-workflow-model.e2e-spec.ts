import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

const migrationName = '20261024120000_viewing_workflow_model';
const migrations = resolve(process.cwd(), 'prisma/migrations');

describe('Viewing workflow model migration and PostgreSQL invariants', () => {
  let pool: Pool;
  let db: PoolClient;
  const schema = `viewing_model_${randomUUID().replaceAll('-', '')}`;
  const userId = randomUUID();
  let order = 0;
  const legacy = new Map<
    string,
    { applicationId: string; viewingId: string }
  >();
  let oldDecisions: unknown[];
  let oldActivities: unknown[];

  function sql<T extends QueryResultRow = Record<string, unknown>>(
    query: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return db.query<T>(query, values);
  }

  async function application() {
    const listingId = randomUUID();
    const applicationId = randomUUID();
    await sql(
      `INSERT INTO listings (id, provider_id, display_order, photos, updated_at, status) VALUES ($1,$2,$3,ARRAY[]::text[],now(),'published')`,
      [listingId, userId, ++order],
    );
    await sql(
      `INSERT INTO applications (id,listing_id,applicant_id,status,active_at,updated_at) VALUES ($1,$2,$3,'active','2025-01-01Z',now())`,
      [applicationId, listingId, userId],
    );
    return { applicationId, listingId };
  }

  async function oldViewing(
    status: string,
    accepted = false,
    corrected = false,
  ) {
    await sql('BEGIN');
    const { applicationId } = await application();
    const viewingId = randomUUID();
    await sql(
      `INSERT INTO application_viewings (id,application_id,round,status,starts_at,ends_at,time_zone,provider_note,accepted_at,declined_at,change_requested_at,change_request_message,cancelled_at,superseded_at,request_key,request_hash,created_at,updated_at)
       VALUES ($1,$2,1,$3::"ApplicationViewingStatus",'2025-02-01T10:00Z','2025-02-01T10:30Z','Europe/Berlin','Original note',
         CASE WHEN $4 THEN '2025-01-02Z'::timestamptz END,
         CASE WHEN $3='declined' THEN '2025-01-03Z'::timestamptz END,
         CASE WHEN $3='change_requested' THEN '2025-01-03Z'::timestamptz END,
         CASE WHEN $3='change_requested' THEN 'Another day please' END,
         CASE WHEN $3='cancelled' THEN '2025-01-03Z'::timestamptz END,
         CASE WHEN $3='superseded' THEN '2025-01-03Z'::timestamptz END,
         $5,$6,'2025-01-01Z','2025-02-02Z')`,
      [
        viewingId,
        applicationId,
        status,
        accepted,
        randomUUID(),
        'a'.repeat(64),
      ],
    );
    if (status === 'completed' || status === 'no_show') {
      await sql(
        `INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome,recorded_at) VALUES ($1,$2,1,$3::"ViewingOutcome",'2025-02-02Z')`,
        [randomUUID(), viewingId, corrected ? 'no_show' : status],
      );
      if (corrected) {
        await sql(
          `INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome,correction_reason,recorded_at) VALUES ($1,$2,2,'completed','Corrected original decision','2025-02-02T01:00Z')`,
          [randomUUID(), viewingId],
        );
        await sql(
          `INSERT INTO application_viewing_interests (id,viewing_id,interest,responded_at) VALUES ($1,$2,'still_interested','2025-02-02T02:00Z')`,
          [randomUUID(), viewingId],
        );
      }
    }
    await sql(
      `INSERT INTO application_activities (id,application_id,type,actor_type,visibility,payload) VALUES ($1,$2,'viewing_proposed','provider','both',$3::jsonb)`,
      [
        randomUUID(),
        applicationId,
        JSON.stringify({ viewingId, viewingRound: 1 }),
      ],
    );
    await sql('COMMIT');
    return { applicationId, viewingId };
  }

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
      throw new Error('Dedicated E2E database and reset marker required');
    assertSafeE2EDatabaseUrl(url);
    pool = new Pool({ connectionString: url });
    db = await pool.connect();
    // Isolated schema: replay real migrations and test populated backfill without
    // resetting public or mutating the developer database.
    await sql(`CREATE SCHEMA "${schema}"`);
    await sql(`SET search_path TO "${schema}"`);
    for (const name of readdirSync(migrations).sort()) {
      if (name >= migrationName || name === 'migration_lock.toml') continue;
      await sql(
        readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8'),
      );
    }
    await sql(
      `INSERT INTO users (id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES ($1,'Migration fixture',$2,'unusable',now(),now(),now())`,
      [userId, `${userId}@e2e.renyqo.test`],
    );
    for (const status of [
      'proposed',
      'accepted',
      'declined',
      'change_requested',
      'cancelled',
      'completed',
      'no_show',
      'superseded',
    ]) {
      legacy.set(
        status,
        await oldViewing(
          status,
          ['accepted', 'completed', 'no_show'].includes(status),
        ),
      );
    }
    legacy.set(
      'accepted_then_change',
      await oldViewing('change_requested', true),
    );
    legacy.set('corrected', await oldViewing('completed', true, true));
    oldDecisions = (
      await sql('SELECT * FROM application_viewing_outcomes ORDER BY id')
    ).rows;
    oldActivities = (
      await sql('SELECT * FROM application_activities ORDER BY id')
    ).rows;
    await sql(
      readFileSync(resolve(migrations, migrationName, 'migration.sql'), 'utf8'),
    );
  }, 30000);

  beforeEach(async () => {
    await sql('BEGIN');
  });
  afterEach(async () => {
    await sql('ROLLBACK');
  });
  afterAll(async () => {
    if (db) {
      await sql('ROLLBACK');
      // schema is a generated fixed-prefix identifier created above, on renyqo_e2e only.
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
      db.release();
    }
    if (pool) await pool.end();
  });

  async function proposal(
    workflowId: string,
    round: number,
    side = 'provider',
    predecessor: string | null = null,
    base: string | null = null,
    options: {
      startsAt?: string;
      endsAt?: string;
      deadline?: string | null;
      timing?: string;
      zone?: string;
    } = {},
  ) {
    const id = randomUUID();
    await sql(
      `INSERT INTO viewing_proposals (id,workflow_id,round,proposer_side,responder_side,starts_at,ends_at,time_zone,predecessor_proposal_id,base_appointment_id,timing,response_deadline_at,request_key,request_hash,created_at)
       VALUES ($1,$2,$3,$4::"ViewingParticipantSide",$5::"ViewingParticipantSide",$10,$11,$12,$6,$7,$13::"ViewingProposalTiming",$14,$8,$9,'2027-02-01T10:00Z')`,
      [
        id,
        workflowId,
        round,
        side,
        side === 'provider' ? 'applicant' : 'provider',
        predecessor,
        base,
        randomUUID(),
        'b'.repeat(64),
        options.startsAt ?? '2027-02-03T10:00Z',
        options.endsAt ?? '2027-02-03T10:30Z',
        options.zone ?? 'Europe/Berlin',
        options.timing ?? 'normal',
        options.deadline === undefined ? '2027-02-01T22:00Z' : options.deadline,
      ],
    );
    return id;
  }

  async function workflow() {
    const app = await application();
    const workflowId = randomUUID();
    await sql(
      `INSERT INTO viewing_workflows (id,application_id,updated_at) VALUES ($1,$2,now())`,
      [workflowId, app.applicationId],
    );
    const proposalId = await proposal(workflowId, 1);
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
      [workflowId, proposalId],
    );
    return { ...app, workflowId, proposalId };
  }

  async function confirm(
    w: Awaited<ReturnType<typeof workflow>>,
    proposalId = w.proposalId,
    round = 1,
  ) {
    const viewingId = randomUUID();
    await sql(
      `UPDATE viewing_proposals SET resolution='accepted',resolved_at='2027-02-01T11:00Z',resolved_by=CASE WHEN responder_side='applicant' THEN 'applicant'::"ApplicationActivityActorType" ELSE 'provider'::"ApplicationActivityActorType" END WHERE id=$1`,
      [proposalId],
    );
    await sql(
      `INSERT INTO application_viewings (id,application_id,round,status,starts_at,ends_at,time_zone,accepted_at,request_key,request_hash,updated_at) SELECT $1,$2,$3,'accepted',starts_at,ends_at,time_zone,'2027-02-01T11:00Z',request_key,request_hash,now() FROM viewing_proposals WHERE id=$4`,
      [viewingId, w.applicationId, round, proposalId],
    );
    await sql(
      `INSERT INTO viewing_appointments (viewing_id,workflow_id,proposal_id) VALUES ($1,$2,$3)`,
      [viewingId, w.workflowId, proposalId],
    );
    await sql(
      'UPDATE viewing_workflows SET confirmed_appointment_id=$2,pending_proposal_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId, viewingId],
    );
    return viewingId;
  }

  async function valid() {
    await sql('SET CONSTRAINTS ALL IMMEDIATE');
  }
  async function invalid() {
    await expect(valid()).rejects.toMatchObject({ code: '23514' });
  }

  it('preserves IDs, outcomes/corrections, messages and activity without fabricated deadlines or attribution', async () => {
    const proposals = await sql<{
      id: string;
      timing: string;
      response_deadline_at: Date | null;
    }>('SELECT id,timing,response_deadline_at FROM viewing_proposals');
    expect(proposals.rows.map((r) => r.id).sort()).toEqual(
      [...legacy.values()].map((r) => r.viewingId).sort(),
    );
    expect(
      proposals.rows.every(
        (r) => r.timing === 'legacy' && r.response_deadline_at === null,
      ),
    ).toBe(true);
    const decisions = (
      await sql('SELECT * FROM application_viewing_outcomes ORDER BY id')
    ).rows;
    expect(
      decisions.map((row) => {
        const copy = { ...row };
        delete copy.absence_side;
        return copy;
      }),
    ).toEqual(oldDecisions);
    expect(decisions.every((row) => row.absence_side === null)).toBe(true);
    expect(
      (await sql('SELECT * FROM application_activities ORDER BY id')).rows,
    ).toEqual(oldActivities);
    expect(
      (
        await sql(
          `SELECT change_request_message FROM application_viewings WHERE id=$1`,
          [legacy.get('change_requested')!.viewingId],
        )
      ).rows[0].change_request_message,
    ).toBe('Another day please');
    const appointments = (await sql('SELECT * FROM viewing_appointments')).rows;
    expect(appointments).toHaveLength(5);
    expect(
      appointments.every(
        (r) => r.interest_deadline_at === null && r.cancelled_by === null,
      ),
    ).toBe(true);
    expect(
      appointments.find(
        (r) => r.viewing_id === legacy.get('completed')!.viewingId,
      )?.interest_state,
    ).toBe('legacy_unanswered');
    expect(
      appointments.find(
        (r) => r.viewing_id === legacy.get('corrected')!.viewingId,
      )?.interest_state,
    ).toBe('still_interested');
    expect(
      (await sql(`SELECT mode,revision FROM viewing_workflows`)).rows.every(
        (r) => r.mode === 'legacy' && r.revision === 0,
      ),
    ).toBe(true);
  });

  it('maps a change request to the original declined offer without inventing an alternative', async () => {
    const id = legacy.get('change_requested')!.viewingId;
    expect(
      (await sql('SELECT resolution FROM viewing_proposals WHERE id=$1', [id]))
        .rows[0].resolution,
    ).toBe('declined');
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM viewing_appointments WHERE viewing_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    const acceptedId = legacy.get('accepted_then_change')!.viewingId;
    expect(
      (
        await sql('SELECT resolution FROM viewing_proposals WHERE id=$1', [
          acceptedId,
        ])
      ).rows[0].resolution,
    ).toBe('accepted');
    await valid();
  });

  it('backfills ACTIVE order from existing activeAt/id and allocates distinct future positions', async () => {
    const expected = (
      await sql(
        `SELECT id FROM applications WHERE status='active' ORDER BY listing_id,active_at ASC NULLS LAST,id`,
      )
    ).rows.map((r) => r.id);
    const actual = (
      await sql(
        'SELECT application_id FROM application_consideration_positions ORDER BY position',
      )
    ).rows.map((r) => r.application_id);
    expect(actual).toEqual(expected);
    const app = await application();
    const next = await sql<{ position: string }>(
      'INSERT INTO application_consideration_positions (application_id,listing_id) VALUES ($1,$2) RETURNING position',
      [app.applicationId, app.listingId],
    );
    expect(BigInt(next.rows[0].position)).toBeGreaterThan(
      BigInt(expected.length),
    );
    await valid();
  });

  it('supports a confirmed appointment plus applicant replacement without losing the commitment', async () => {
    const w = await workflow();
    const appointmentId = await confirm(w);
    const alternative = await proposal(
      w.workflowId,
      2,
      'applicant',
      w.proposalId,
      appointmentId,
    );
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
      [w.workflowId, alternative],
    );
    await valid();
    expect(
      (
        await sql(
          'SELECT confirmed_appointment_id,pending_proposal_id FROM viewing_workflows WHERE id=$1',
          [w.workflowId],
        )
      ).rows[0],
    ).toEqual({
      confirmed_appointment_id: appointmentId,
      pending_proposal_id: alternative,
    });
  });

  it('permits an atomic replacement while retaining both accepted schedules in history', async () => {
    const w = await workflow();
    const old = await confirm(w);
    const alternative = await proposal(
      w.workflowId,
      2,
      'applicant',
      w.proposalId,
      old,
    );
    await sql(
      `UPDATE application_viewings SET status='superseded',superseded_at=now() WHERE id=$1`,
      [old],
    );
    const replacement = await confirm(w, alternative, 2);
    await valid();
    expect(replacement).not.toBe(old);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM viewing_appointments WHERE workflow_id=$1',
          [w.workflowId],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it('rejects clearing the confirmed pointer while the commitment remains accepted', async () => {
    const w = await workflow();
    await confirm(w);
    await sql(
      'UPDATE viewing_workflows SET confirmed_appointment_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId],
    );
    await invalid();
  });

  it('rejects applicant initiation and standalone applicant alternatives', async () => {
    const app = await application();
    const workflowId = randomUUID();
    await sql(
      'INSERT INTO viewing_workflows (id,application_id,updated_at) VALUES ($1,$2,now())',
      [workflowId, app.applicationId],
    );
    const id = await proposal(workflowId, 1, 'applicant');
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
      [workflowId, id],
    );
    await invalid();
  });

  it('rejects an applicant round without any invitation/appointment target', async () => {
    const w = await workflow();
    await sql(
      `UPDATE viewing_proposals SET resolution='declined',resolved_at='2027-02-01T11:00Z',resolved_by='applicant' WHERE id=$1`,
      [w.proposalId],
    );
    const id = await proposal(w.workflowId, 2, 'applicant');
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
      [w.workflowId, id],
    );
    await invalid();
  });

  it('rejects a pending pointer to another application workflow', async () => {
    const first = await workflow();
    const other = await workflow();
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=NULL,revision=revision+1 WHERE id=$1',
      [other.workflowId],
    );
    await expect(
      sql(
        'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
        [first.workflowId, other.proposalId],
      ),
    ).resolves.toBeDefined();
    await expect(
      sql('SET CONSTRAINTS pending_proposal_same_workflow IMMEDIATE'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects multiple pending rounds', async () => {
    const w = await workflow();
    await expect(
      proposal(w.workflowId, 2, 'applicant', w.proposalId),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('protects proposal schedules and terminal responses from overwrites', async () => {
    const w = await workflow();
    await expect(
      sql(
        `UPDATE viewing_proposals SET starts_at=starts_at+interval '1 hour' WHERE id=$1`,
        [w.proposalId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires revision increments for workflow updates', async () => {
    const w = await workflow();
    await expect(
      sql(
        `UPDATE viewing_workflows SET provider_consideration='continue_considering',consideration_decided_at=now() WHERE id=$1`,
        [w.workflowId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects fake provider consideration without actual NOT_SELECTED rejection', async () => {
    const w = await workflow();
    await sql(
      `UPDATE viewing_workflows SET provider_consideration='do_not_continue',consideration_decided_at=now(),revision=revision+1 WHERE id=$1`,
      [w.workflowId],
    );
    await invalid();
  });

  it('requires attributed no-show for a current appointment', async () => {
    const w = await workflow();
    const id = await confirm(w);
    await sql(`UPDATE application_viewings SET status='no_show' WHERE id=$1`, [
      id,
    ]);
    await sql(
      `INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome) VALUES ($1,$2,1,'no_show')`,
      [randomUUID(), id],
    );
    await sql(
      'UPDATE viewing_workflows SET confirmed_appointment_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId],
    );
    await invalid();
  });

  it.each(['applicant', 'provider', 'both'])(
    'stores attributed %s absence without changing ACTIVE status',
    async (side) => {
      const w = await workflow();
      const id = await confirm(w);
      await sql(
        `UPDATE application_viewings SET status='no_show' WHERE id=$1`,
        [id],
      );
      await sql(
        `INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome,absence_side) VALUES ($1,$2,1,'no_show',$3::"ViewingAbsenceSide")`,
        [randomUUID(), id, side],
      );
      await sql(
        'UPDATE viewing_workflows SET confirmed_appointment_id=NULL,revision=revision+1 WHERE id=$1',
        [w.workflowId],
      );
      await valid();
      expect(
        (
          await sql('SELECT status FROM applications WHERE id=$1', [
            w.applicationId,
          ])
        ).rows[0].status,
      ).toBe('active');
    },
  );

  it('requires structured cancellation attribution', async () => {
    const w = await workflow();
    const id = await confirm(w);
    await sql(
      `UPDATE application_viewings SET status='cancelled',cancelled_at=now() WHERE id=$1`,
      [id],
    );
    await sql(
      'UPDATE viewing_workflows SET confirmed_appointment_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId],
    );
    await invalid();
  });

  it('requires a 48-hour interest window after current completion', async () => {
    const w = await workflow();
    const id = await confirm(w);
    await sql(
      `UPDATE application_viewings SET status='completed' WHERE id=$1`,
      [id],
    );
    await sql(
      `INSERT INTO application_viewing_outcomes (id,viewing_id,revision,outcome) VALUES ($1,$2,1,'completed')`,
      [randomUUID(), id],
    );
    await sql(
      `UPDATE viewing_appointments SET interest_state='pending',interest_requested_at=now(),interest_deadline_at=now()+interval '48 hours' WHERE viewing_id=$1`,
      [id],
    );
    await sql(
      'UPDATE viewing_workflows SET confirmed_appointment_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId],
    );
    await valid();
  });

  it('allows legacy writers only while the workflow remains explicitly LEGACY', async () => {
    const old = legacy.get('proposed')!;
    await sql(
      `UPDATE application_viewings SET status='declined',declined_at=now() WHERE id=$1`,
      [old.viewingId],
    );
    await valid();
    expect(
      (
        await sql(
          'SELECT mode FROM viewing_workflows WHERE application_id=$1',
          [old.applicationId],
        )
      ).rows[0].mode,
    ).toBe('legacy');
  });

  it.each([
    { deadline: null },
    { deadline: '2027-02-04T10:00Z' },
    { deadline: '2027-02-01T22:00:00.001Z' },
    { startsAt: '2027-02-02T03:00Z', endsAt: '2027-02-02T03:30Z' },
    { endsAt: '2027-02-03T10:04:59Z' },
    { endsAt: '2027-02-03T14:00:01Z' },
    { zone: 'MEZ' },
    { zone: 'Imaginary/Timezone' },
    { timing: 'legacy', deadline: null },
  ])('rejects invalid new proposal schedule/deadline: %j', async (options) => {
    const app = await application();
    const id = randomUUID();
    await sql(
      'INSERT INTO viewing_workflows (id,application_id,updated_at) VALUES ($1,$2,now())',
      [id, app.applicationId],
    );
    await expect(
      proposal(id, 1, 'provider', null, null, options),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('represents short-notice invitations explicitly', async () => {
    const app = await application();
    const id = randomUUID();
    await sql(
      'INSERT INTO viewing_workflows (id,application_id,updated_at) VALUES ($1,$2,now())',
      [id, app.applicationId],
    );
    const offer = await proposal(id, 1, 'provider', null, null, {
      timing: 'short_notice',
      startsAt: '2027-02-01T16:00Z',
      endsAt: '2027-02-01T16:30Z',
      deadline: '2027-02-01T14:00Z',
    });
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=$2,revision=revision+1 WHERE id=$1',
      [id, offer],
    );
    await valid();
  });

  it('does not let runtime writers create LEGACY workflows to bypass invariants', async () => {
    const app = await application();
    await expect(
      sql(
        `INSERT INTO viewing_workflows (id,application_id,mode,updated_at) VALUES ($1,$2,'legacy',now())`,
        [randomUUID(), app.applicationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a confirmed schedule different from its accepted proposal', async () => {
    const w = await workflow();
    const id = await confirm(w);
    await sql(
      `UPDATE application_viewings SET starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' WHERE id=$1`,
      [id],
    );
    await invalid();
  });

  it('rejects an accepted offer without an appointment', async () => {
    const w = await workflow();
    await sql(
      `UPDATE viewing_proposals SET resolution='accepted',resolved_at='2027-02-01T11:00Z',resolved_by='applicant' WHERE id=$1`,
      [w.proposalId],
    );
    await sql(
      'UPDATE viewing_workflows SET pending_proposal_id=NULL,revision=revision+1 WHERE id=$1',
      [w.workflowId],
    );
    await invalid();
  });

  it('protects terminal responses from later edits', async () => {
    const w = await workflow();
    await confirm(w);
    await expect(
      sql(`UPDATE viewing_proposals SET resolution='declined' WHERE id=$1`, [
        w.proposalId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires the intended responder to accept', async () => {
    const w = await workflow();
    await expect(
      sql(
        `UPDATE viewing_proposals SET resolution='accepted',resolved_at='2027-02-01T11:00Z',resolved_by='provider' WHERE id=$1`,
        [w.proposalId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('does not reopen acceptance at the response deadline', async () => {
    const w = await workflow();
    await expect(
      sql(
        `UPDATE viewing_proposals SET resolution='accepted',resolved_at=response_deadline_at,resolved_by='applicant' WHERE id=$1`,
        [w.proposalId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each([null, '2027-02-03T09:59:59Z'])(
    'rejects missing/incorrect 48-hour interest deadline: %s',
    async (deadline) => {
      const w = await workflow();
      const id = await confirm(w);
      await expect(
        sql(
          `UPDATE viewing_appointments SET interest_state='pending',interest_requested_at='2027-02-01T10:00Z',interest_deadline_at=$2 WHERE viewing_id=$1`,
          [id, deadline],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('cannot extend an opened post-viewing deadline', async () => {
    const w = await workflow();
    const id = await confirm(w);
    await sql(
      `UPDATE viewing_appointments SET interest_state='pending',interest_requested_at='2027-02-01T10:00Z',interest_deadline_at='2027-02-03T10:00Z' WHERE viewing_id=$1`,
      [id],
    );
    await expect(
      sql(
        `UPDATE viewing_appointments SET interest_requested_at=interest_requested_at+interval '1 hour',interest_deadline_at=interest_deadline_at+interval '1 hour' WHERE viewing_id=$1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('prevents ACTIVE consideration positions being attached to another listing', async () => {
    const one = await application();
    const two = await application();
    await sql(
      'INSERT INTO application_consideration_positions (application_id,listing_id) VALUES ($1,$2)',
      [one.applicationId, two.listingId],
    );
    await expect(
      sql('SET CONSTRAINTS consideration_same_listing IMMEDIATE'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects stale repeatable-read proposal writes after another workflow update', async () => {
    const w = await workflow();
    await confirm(w);
    await sql('COMMIT');
    const other = await pool.connect();
    try {
      await other.query(`SET search_path TO "${schema}"`);
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await other.query('SELECT revision FROM viewing_workflows WHERE id=$1', [
        w.workflowId,
      ]);
      await sql(
        `UPDATE viewing_workflows SET provider_consideration='continue_considering',consideration_decided_at=now(),revision=revision+1 WHERE id=$1`,
        [w.workflowId],
      );
      await expect(
        other.query(
          `INSERT INTO viewing_proposals (id,workflow_id,round,proposer_side,responder_side,starts_at,ends_at,time_zone,predecessor_proposal_id,timing,response_deadline_at,request_key,request_hash,created_at)
        SELECT $1,workflow_id,2,'applicant','provider',starts_at,ends_at,time_zone,id,timing,response_deadline_at,$2,request_hash,created_at FROM viewing_proposals WHERE id=$3`,
          [randomUUID(), randomUUID(), w.proposalId],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await other.query('ROLLBACK');
      other.release();
      await sql('BEGIN');
    }
  });
});
