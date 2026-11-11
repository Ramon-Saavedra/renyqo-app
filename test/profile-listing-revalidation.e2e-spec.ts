import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TenantFixture } from './workspace-tenant.fixture';

jest.setTimeout(30000);
describe('Bounded cross-workspace profile Listing input locks', () => {
  const f = new TenantFixture();
  let applicant: string, foreign: string;
  let workspaces: Awaited<ReturnType<TenantFixture['organization']>>[];
  const ids: string[] = [];
  beforeAll(async () => {
    await f.start();
    workspaces = [await f.organization(), await f.organization()];
    applicant = await f.user();
    foreign = await f.user();
    await f.activate();
    await f.pool.query(
      readFileSync(
        'prisma/migrations/20261108150000_listing_workspace_assignment/migration.sql',
        'utf8',
      ),
    );
    for (const w of workspaces) {
      const id = randomUUID();
      ids.push(id);
      await f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,title,photos)
          VALUES($1,$2,$3,$3,1,'Eligibility',ARRAY[]::text[])`,
          [id, w.id, w.owner],
        );
        await c.query(
          `INSERT INTO listing_assignment_transitions(id,workspace_id,listing_id,sequence,new_membership_id,reason,initiated_by_membership_id,command_id)
          VALUES($1,$2,$3,1,$4,'INITIAL',$4,$5)`,
          [randomUUID(), w.id, id, w.owner, randomUUID()],
        );
      });
      await f.prisma.application.create({
        data: { listingId: id, applicantId: applicant, status: 'WAITING' },
      });
    }
  });
  afterAll(() => f.stop());
  it('returns only own application eligibility inputs across workspaces, then clears helper identity', async () => {
    await f.runtimeSql(null, async (c) => {
      const rows = (
        await c.query<{ id: string } & Record<string, unknown>>(
          'SELECT * FROM lock_profile_revalidation_listings($1)',
          [applicant],
        )
      ).rows;
      expect(rows.map((r: { id: string }) => r.id)).toEqual([...ids].sort());
      expect(Object.keys(rows[0])).toEqual([
        'id',
        'status',
        'minimumHouseholdNetIncome',
        'suitableForPeopleCount',
        'petsPolicy',
        'smokingPolicy',
        'schufaRequired',
        'incomeProofRequired',
      ]);
      expect(
        (
          await c.query<{ identity: string | null }>(
            `SELECT nullif(current_setting('app.profile_revalidation_user',true),'') AS identity`,
          )
        ).rows[0].identity,
      ).toBeNull();
      expect((await c.query('SELECT id FROM listings')).rows).toEqual([]);
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([]);
    });
  });
  it('cannot inspect another applicant relationship or activate the policies through forged settings', async () => {
    await f.runtimeSql(null, async (c) => {
      expect(
        (
          await c.query(
            'SELECT * FROM lock_profile_revalidation_listings($1)',
            [foreign],
          )
        ).rows,
      ).toEqual([]);
      await c.query(
        `SELECT set_config('app.profile_revalidation_user',$1,true)`,
        [applicant],
      );
      expect((await c.query('SELECT id FROM listings')).rows).toEqual([]);
    });
    await expect(
      f.runtimePool.query('SET ROLE renyqo_profile_revalidation'),
    ).rejects.toThrow();
  });
  it('cannot enter the helper from an ordinary tenant transaction', async () => {
    await expect(
      f.runtimeSql(workspaces[0].id, (c) =>
        c.query('SELECT * FROM lock_profile_revalidation_listings($1)', [
          applicant,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
