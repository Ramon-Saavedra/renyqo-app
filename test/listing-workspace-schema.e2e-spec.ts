import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TenantFixture } from './workspace-tenant.fixture';

jest.setTimeout(30000);
describe('Listing tenancy schema under restricted PostgreSQL login', () => {
  const f = new TenantFixture();
  let s: Awaited<ReturnType<TenantFixture['subject']>>;
  beforeAll(async () => {
    await f.start();
    s = await f.subject(true);
    await f.activate();
    await f.pool.query(
      readFileSync(
        'prisma/migrations/20261108150000_listing_workspace_assignment/migration.sql',
        'utf8',
      ),
    );
  });
  afterAll(() => f.stop());

  it('creates required tenant columns and adopts FORCE RLS without retaining provider ownership', async () => {
    const columns = (
      await f.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='listings'`,
        [f.schema],
      )
    ).rows.map((r) => r.column_name);
    expect(columns).not.toContain('provider_id');
    expect(columns).toEqual(
      expect.arrayContaining([
        'workspace_id',
        'created_by_membership_id',
        'responsible_membership_id',
        'revision',
        'retired_at',
      ]),
    );
    expect((await f.runtimePool.query('SELECT id FROM listings')).rows).toEqual(
      [],
    );
  });

  it('requires initial evidence and maintains only allowlisted public projections atomically', async () => {
    const id = randomUUID();
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(
        `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,title,street,photos)
        VALUES($1,$2,$3,$3,1,'Public title','Private street',ARRAY[]::text[])`,
        [id, s.w.id, s.membershipId],
      );
      await c.query(
        `INSERT INTO listing_assignment_transitions(id,workspace_id,listing_id,sequence,new_membership_id,reason,initiated_by_membership_id,command_id)
        VALUES($1,$2,$3,1,$4,'INITIAL',$4,$5)`,
        [randomUUID(), s.w.id, id, s.membershipId, randomUUID()],
      );
      await c.query(
        `UPDATE listings SET status='published',published_at=clock_timestamp(),
          minimum_household_net_income=2500,schufa_required=true,income_proof_required=true,
          suitable_for_people_count=2 WHERE id=$1`,
        [id],
      );
    });
    const projection = (
      await f.runtimePool.query(
        'SELECT * FROM public_listing_projections WHERE id=$1',
        [id],
      )
    ).rows[0] as Record<string, unknown>;
    expect(projection['title']).toBe('Public title');
    expect(projection['public_street']).toBeNull();
    expect(Number(projection['minimum_household_net_income'])).toBe(2500);
    expect(projection['schufa_required']).toBe(true);
    expect(projection['income_proof_required']).toBe(true);
    expect(projection['suitable_for_people_count']).toBe(2);
    expect(projection).not.toHaveProperty('criteria_version');
    expect(projection).not.toHaveProperty('responsible_membership_id');
    expect(projection).not.toHaveProperty('workspace_id');
    expect(projection).not.toHaveProperty('created_by_membership_id');
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(`UPDATE listings SET status='paused' WHERE id=$1`, [id]);
    });
    expect(
      (
        await f.runtimePool.query(
          'SELECT * FROM public_listing_projections WHERE id=$1',
          [id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('withdraws public listings atomically when the workspace begins closing', async () => {
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(
        `UPDATE listings SET status='published',published_at=clock_timestamp() WHERE workspace_id=$1`,
        [s.w.id],
      );
    });
    expect(
      (await f.runtimePool.query('SELECT id FROM public_listing_projections'))
        .rowCount,
    ).toBe(1);
    await expect(
      f.runtimeSql(s.w.id, async (c) => {
        await c.query(
          `UPDATE provider_workspaces SET lifecycle_status='CLOSING',closing_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
          [s.w.id],
        );
        expect(
          (await c.query('SELECT id FROM public_listing_projections')).rowCount,
        ).toBe(0);
        throw new Error('Rollback closing');
      }),
    ).rejects.toThrow('Rollback closing');
    expect(
      (await f.runtimePool.query('SELECT id FROM public_listing_projections'))
        .rowCount,
    ).toBe(1);
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query(
        `UPDATE provider_workspaces SET lifecycle_status='CLOSING',closing_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
        [s.w.id],
      );
    });
    expect(
      (await f.runtimePool.query('SELECT id FROM public_listing_projections'))
        .rowCount,
    ).toBe(0);
  });
});
