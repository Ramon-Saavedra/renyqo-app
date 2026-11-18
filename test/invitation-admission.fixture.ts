import { randomUUID } from 'node:crypto';
import type { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { issueSecret } from '../src/security/opaque-secret';

export const invitationMigrations = [
  '20261117100000_invitation_identity_schema',
  '20261117101000_invitation_lifecycle_guards',
  '20261117102000_invitation_bootstrap',
  '20261117103000_invitation_admission',
  '20261117104000_email_verification_guards',
];

// Existing domain fixtures enroll through the actual restricted-login admission
// function; no disabled guards, forged acceptance evidence or privileged INSERT.
export async function admitFixtureAgent(
  f: ListingWorkspaceFixture,
  workspaceId: string,
  userId: string,
  memberId: string = randomUUID(),
) {
  await f.prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true },
  });
  const id = randomUUID(),
    reservation = randomUUID(),
    command = randomUUID();
  const { hash } = issueSecret('workspace-invitation');
  return f.runtimeSql(workspaceId, async (c) => {
    await c.query(
      `SELECT u.id FROM users u WHERE u.id=$1 OR u.id IN
      (SELECT user_id FROM workspace_memberships WHERE workspace_id=$2 AND role='OWNER') ORDER BY u.id FOR SHARE`,
      [userId, workspaceId],
    );
    const {
      rows: [w],
    } = await c.query<{ ownership_revision: number }>(
      'SELECT ownership_revision FROM provider_workspaces WHERE id=$1',
      [workspaceId],
    );
    await c.query('SELECT lock_workspace_ownership_revision($1,$2)', [
      workspaceId,
      w.ownership_revision,
    ]);
    await c.query(
      'SELECT id FROM workspace_memberships WHERE workspace_id=$1 ORDER BY id FOR UPDATE',
      [workspaceId],
    );
    await c.query(
      `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
      [reservation, workspaceId, command],
    );
    await c.query(
      `INSERT INTO workspace_invitations(id,workspace_id,email,created_by_membership_id,reservation_id,token_hash,
      expires_at,issuer_membership_revision,issuer_auth_version,ownership_revision)
      SELECT $1,$2,account.email,m.id,$3,$4,r.expires_at,m.revision,issuer.auth_version,$5
      FROM workspace_memberships m JOIN users issuer ON issuer.id=m.user_id
      JOIN users account ON account.id=$6 JOIN workspace_seat_reservations r ON r.id=$3
      WHERE m.workspace_id=$2 AND m.role='OWNER'`,
      [id, workspaceId, reservation, hash, w.ownership_revision, userId],
    );
    await c.query('SELECT admit_workspace_invitation($1,$2,$3,$4,$5)', [
      id,
      userId,
      hash,
      randomUUID(),
      memberId,
    ]);
    return memberId;
  });
}
