import { randomUUID } from 'node:crypto';
import { AuditLifecycleFixture } from './audit-lifecycle.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
import type { PoolClient } from 'pg';

jest.setTimeout(60000);
describe('Lifecycle Audit execution provenance', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(1));
  afterAll(() => f.stop());
  async function run<T>(
    workspaceId: string | null,
    work: (c: PoolClient) => Promise<T>,
  ) {
    const c = await f.db.applicationPool.connect();
    try {
      await c.query('BEGIN');
      if (workspaceId) await sqlTenant(c, workspaceId);
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  const command = () => ({
    commandId: randomUUID(),
    correlationId: randomUUID(),
    commandScope: 'application.lifecycle.system',
    requiredEffects: ['application.promoted'],
  });
  it('runtime cannot inspect private execution bookkeeping', async () => {
    for (const table of [
      'audit_profile_scopes',
      'audit_profile_bindings',
      'audit_activity_sources',
      'audit_application_changes',
    ]) {
      await expect(
        run(null, (c) => c.query(`SELECT * FROM ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('profile scope requires a current authenticated session and cannot survive commit', async () => {
    const a = await f.applicant(),
      authority = await f.db.session(a.id);
    await expect(
      run(null, (c) =>
        c.query('SELECT open_profile_audit_scope($1,$2,$3)', [
          a.id,
          authority.authVersion,
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      run(null, (c) =>
        c.query('SELECT open_profile_audit_scope($1,$2,$3)', [
          a.id,
          authority.authVersion,
          authority.sessionId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.db.prisma.auditProfileScope.count()).toBe(0);
  });
  it('rejects a fabricated SYSTEM promotion activity without a real status transition', async () => {
    const listingId = await f.published(),
      applicant = await f.applicant(),
      response = await applicant.client
        .post(`/api/v1/listings/${listingId}/apply`)
        .expect(201),
      applicationId = (response.body as { id: string }).id,
      activity = randomUUID();
    await expect(
      run(f.workspaces[0].id, async (c) => {
        await c.query(
          `INSERT INTO application_activities(id,application_id,type,actor_type,visibility,payload)
           VALUES($1,$2,'application_promoted_to_active','system','both',$3::jsonb)`,
          [
            activity,
            applicationId,
            JSON.stringify({ fromStatus: 'WAITING', toStatus: 'ACTIVE' }),
          ],
        );
        await c.query('SELECT open_system_lifecycle_audit($1,$2::jsonb)', [
          activity,
          JSON.stringify(command()),
        ]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await f.db.prisma.applicationActivity.count({ where: { id: activity } }),
    ).toBe(0);
    expect(await f.db.prisma.auditActivitySource.count()).toBe(0);
    expect(await f.db.prisma.auditApplicationChange.count()).toBe(0);
    expect((await f.events(listingId)).map((e) => e.action)).toEqual([
      'application.submitted',
    ]);
  });
  it('released savepoint provenance survives until commit and is then removed', async () => {
    const listingId = await f.published(),
      applicantId = await f.db.user(),
      applicationId = randomUUID(),
      activityId = randomUUID();
    await run(f.workspaces[0].id, async (c) => {
      await c.query('SAVEPOINT lifecycle_proof');
      await c.query(
        `INSERT INTO applications(id,listing_id,applicant_id,status,updated_at)
         VALUES($1,$2,$3,'waiting',clock_timestamp())`,
        [applicationId, listingId, applicantId],
      );
      await c.query(
        `INSERT INTO application_activities(id,application_id,type,actor_type,visibility,payload)
        VALUES($1,$2,'application_submitted','applicant','applicant',$3::jsonb)`,
        [
          activityId,
          applicationId,
          JSON.stringify({ initialStatus: 'WAITING' }),
        ],
      );
      await c.query('RELEASE SAVEPOINT lifecycle_proof');
      const refs = await c.query(
        'SELECT * FROM audit_application_effect_refs($1::jsonb)',
        [JSON.stringify([listingId])],
      );
      expect(refs.rows).toEqual([
        expect.objectContaining({ id: activityId, applicationId }),
      ]);
    });
    expect(await f.db.prisma.auditApplicationChange.count()).toBe(0);
    expect(await f.db.prisma.auditActivitySource.count()).toBe(0);
  });
  it('SYSTEM queue purpose cannot label a different real state transition as promotion', async () => {
    const listingId = await f.published(),
      a = await f.applicant();
    const response = await a.client
      .post(`/api/v1/listings/${listingId}/apply`)
      .expect(201);
    const applicationId = (response.body as { id: string }).id,
      activityId = randomUUID();
    await expect(
      run(f.workspaces[0].id, async (c) => {
        await c.query("UPDATE applications SET status='rejected' WHERE id=$1", [
          applicationId,
        ]);
        await c.query(
          `INSERT INTO application_activities(id,application_id,type,actor_type,visibility,payload)
        VALUES($1,$2,'application_promoted_to_active','system','both',$3::jsonb)`,
          [
            activityId,
            applicationId,
            JSON.stringify({ fromStatus: 'ACTIVE', toStatus: 'REJECTED' }),
          ],
        );
        await c.query('SELECT open_system_lifecycle_audit($1,$2::jsonb)', [
          activityId,
          JSON.stringify(command()),
        ]);
        // Distinguish rejection by the opener from an unclosed-context commit error.
        throw new Error('SYSTEM opener accepted an ineligible transition');
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await f.db.prisma.application.findUniqueOrThrow({
        where: { id: applicationId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(await f.db.prisma.auditExecutionContext.count()).toBe(0);
  });
  it('an old committed activity cannot mint a new SYSTEM context', async () => {
    const listingId = await f.published(),
      a = await f.applicant();
    await a.client.post(`/api/v1/listings/${listingId}/apply`).expect(201);
    const activity = await f.db.prisma.applicationActivity.findFirstOrThrow({
      where: { application: { listingId }, type: 'APPLICATION_SUBMITTED' },
    });
    await expect(
      run(f.workspaces[0].id, (c) =>
        c.query('SELECT open_system_lifecycle_audit($1,$2::jsonb)', [
          activity.id,
          JSON.stringify(command()),
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.db.prisma.auditExecutionContext.count()).toBe(0);
  });
});
