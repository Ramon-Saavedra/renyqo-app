import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { issueSecret } from '../src/security/opaque-secret';
jest.setTimeout(60000);
describe('Existing-member admission evidence is not member creation', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('the supported ALREADY_MEMBER admission branch records only the invitation transition', async () => {
    const owner = await f.owner(),
      a = await f.account();
    await f.verify(a);
    await f.invite(owner, a.email);
    const first = await a.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token: f.secret(a.email, 'invitation'), commandId: randomUUID() })
      .expect(200);
    // Seed a pending admission using the real restricted SQL protocol. OWNER HTTP
    // creation correctly refuses existing members; this exercises the defensive
    // admission branch without disabling guards or inventing another workflow.
    const id = randomUUID(),
      reservation = randomUUID(),
      secret = issueSecret('workspace-invitation');
    await f.db.runtimeSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
        [reservation, f.w.id, randomUUID()],
      );
      await c.query(
        `INSERT INTO workspace_invitations(id,workspace_id,email,created_by_membership_id,reservation_id,token_hash,expires_at,issuer_membership_revision,issuer_auth_version,ownership_revision)
      SELECT $1,$2,$3,m.id,r.id,$4,r.expires_at,m.revision,u.auth_version,1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id JOIN workspace_seat_reservations r ON r.id=$5 WHERE m.id=$6`,
        [id, f.w.id, a.email, secret.hash, reservation, f.w.owner],
      );
    });
    const commandId = randomUUID();
    const next = await a.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token: secret.secret, commandId })
      .expect(200);
    expect(next.body).toEqual(first.body);
    const rows = await f.db.prisma.auditEvent.findMany({
      where: { commandId, workspaceId: f.w.id },
    });
    expect(rows.map((r) => r.action)).toEqual(['provider.invitation.accepted']);
    expect(
      await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id },
      }),
    ).toMatchObject({ acceptanceKind: 'ALREADY_MEMBER' });
  });
});
