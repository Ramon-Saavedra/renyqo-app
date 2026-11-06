import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceFixture } from './provider-workspaces.fixture';

describe('Membership additive migration on established workspaces', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start('20261106170000_workspace_membership_lifecycle'));
  afterAll(() => f.stop());

  it('backfills ACTIVE revision one without changing IDs, roles, colors, creation time or ownership epoch', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.sqlTransaction(async (c) => {
      await c.query(
        `INSERT INTO provider_workspaces(id,kind,display_name) VALUES ($1,'ORGANIZATION','Agency')`,
        [input.workspaceId],
      );
      await c.query(
        `INSERT INTO organization_profiles(workspace_id,legal_name) VALUES ($1,'Agency')`,
        [input.workspaceId],
      );
      await c.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color,created_at) VALUES ($1,$2,$3,'OWNER','#ABCDEF','2020-01-01')`,
        [input.membershipId, input.workspaceId, input.userId],
      );
    });
    const before = (
      await f.pool.query('SELECT * FROM workspace_memberships WHERE id=$1', [
        input.membershipId,
      ])
    ).rows[0] as Record<string, unknown>;
    await f.pool.query(
      readFileSync(
        resolve(
          'prisma/migrations/20261106170000_workspace_membership_lifecycle/migration.sql',
        ),
        'utf8',
      ),
    );
    await f.pool.query(
      readFileSync(
        resolve(
          'prisma/migrations/20261106171000_ownership_transfer_intents/migration.sql',
        ),
        'utf8',
      ),
    );
    const after = (
      await f.pool.query('SELECT * FROM workspace_memberships WHERE id=$1', [
        input.membershipId,
      ])
    ).rows[0] as Record<string, unknown>;
    expect(after).toMatchObject({
      ...before,
      status: 'ACTIVE',
      revision: 1,
      updated_at: before['created_at'],
    });
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: input.workspaceId },
      }),
    ).toMatchObject({ ownershipRevision: 1 });
  });
});
