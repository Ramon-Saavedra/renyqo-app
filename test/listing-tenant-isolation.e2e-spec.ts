import { randomUUID } from 'node:crypto';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';

jest.setTimeout(60000);
describe('Operational Listing RLS and immutable tenancy under application login', () => {
  const f = new ListingWorkspaceFixture();
  let a: Awaited<ReturnType<ListingWorkspaceFixture['organization']>>,
    b: typeof a;
  let own: string, foreign: string;
  beforeAll(async () => {
    await f.start();
    a = await f.organization();
    b = await f.organization();
    await f.activateApplication();
    own = await f.listing(a.id, a.owner);
    foreign = await f.listing(b.id, b.owner);
  });
  afterAll(() => f.stop());
  it('raw SELECT exposes only the selected workspace, never no-context or foreign rows', async () => {
    expect(
      (await f.applicationPool.query('SELECT id FROM listings')).rows,
    ).toEqual([]);
    await f.applicationSql(a.id, async (c) => {
      expect(
        (await c.query('SELECT id FROM listings ORDER BY id')).rows,
      ).toEqual([{ id: own }]);
      expect(
        (await c.query('SELECT id FROM listings WHERE id=$1', [foreign])).rows,
      ).toEqual([]);
      expect(
        (await c.query('SELECT listing_id FROM listing_assignment_transitions'))
          .rows,
      ).toEqual([{ listing_id: own }]);
    });
  });
  it('foreign raw UPDATE cannot find or modify its target', async () => {
    await f.applicationSql(a.id, async (c) => {
      expect(
        (
          await c.query(
            `UPDATE listings SET title='Foreign change' WHERE id=$1`,
            [foreign],
          )
        ).rowCount,
      ).toBe(0);
    });
    expect(
      (await f.prisma.listing.findUniqueOrThrow({ where: { id: foreign } }))
        .title,
    ).toBe('Fixture Listing');
  });
  it('INSERT WITH CHECK rejects a foreign workspace', async () => {
    await expect(
      f.applicationSql(a.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [a.id]);
        await c.query(
          `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,photos)
        VALUES($1,$2,$3,$3,2,ARRAY[]::text[])`,
          [randomUUID(), b.id, b.owner],
        );
      }),
    ).rejects.toThrow();
  });
  it.each(['workspace_id', 'created_by_membership_id'])(
    'raw SQL cannot rewrite immutable %s',
    async (column) => {
      await expect(
        f.applicationSql(a.id, async (c) => {
          await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
            a.id,
          ]);
          await c.query(`UPDATE listings SET ${column}=$2 WHERE id=$1`, [
            own,
            column === 'workspace_id' ? b.id : a.agents[0].id,
          ]);
        }),
      ).rejects.toMatchObject({
        code: column === 'workspace_id' ? '42501' : '23514',
      });
    },
  );
  it.each(['created_by_membership_id', 'responsible_membership_id'])(
    'composite tenant consistency rejects foreign %s',
    async (column) => {
      await expect(
        f.applicationSql(a.id, async (c) => {
          await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
            a.id,
          ]);
          await c.query(
            `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,photos)
        VALUES($1,$2,$3,$4,2,ARRAY[]::text[])`,
            [
              randomUUID(),
              a.id,
              column === 'created_by_membership_id' ? b.owner : a.owner,
              column === 'responsible_membership_id' ? b.owner : a.owner,
            ],
          );
        }),
      ).rejects.toThrow();
    },
  );
  it('initial Listing without matching assignment evidence cannot commit', async () => {
    const id = randomUUID();
    await expect(
      f.applicationSql(a.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [a.id]);
        await c.query(
          `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,photos)
        VALUES($1,$2,$3,$3,2,ARRAY[]::text[])`,
          [id, a.id, a.owner],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.prisma.listing.findUnique({ where: { id } })).toBeNull();
  });
  it('history cannot be physically deleted or rewritten', async () => {
    await expect(
      f.applicationSql(a.id, (c) =>
        c.query(
          'DELETE FROM listing_assignment_transitions WHERE listing_id=$1',
          [own],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.applicationSql(a.id, (c) =>
        c.query(
          'UPDATE listing_assignment_transitions SET command_id=$2 WHERE listing_id=$1',
          [own, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.applicationSql(a.id, (c) =>
        c.query('DELETE FROM listings WHERE id=$1', [own]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('ARCHIVED is absent from the canonical lifecycle', async () => {
    const rows = (
      await f.applicationPool.query(
        `SELECT enumlabel FROM pg_enum WHERE enumtypid='"ListingStatus"'::regtype ORDER BY enumsortorder`,
      )
    ).rows;
    expect(rows.map((row: { enumlabel: string }) => row.enumlabel)).toEqual([
      'draft',
      'published',
      'paused',
      'rented',
      'retired',
    ]);
  });
});
