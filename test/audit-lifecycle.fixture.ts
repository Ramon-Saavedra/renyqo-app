import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CapabilityFixture } from './provider-capabilities.fixture';
import { createEligibleApplicantProfile } from './eligible-applicant-fixture';
import type { LifecyclePayloads } from '../src/audit/domain/lifecycle-action';

export class AuditLifecycleFixture extends CapabilityFixture {
  async applicant() {
    const client = request.agent(
      this.app.getHttpServer() as Parameters<typeof request>[0],
    );
    const email = `${randomUUID()}@audit-lifecycle.test`;
    const r = await client
      .post('/api/v1/auth/register')
      .send({
        name: 'Private applicant',
        email,
        password: 'StrongPass123',
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    await createEligibleApplicantProfile(client);
    return { client, id: (r.body as { id: string }).id, email };
  }
  async published(index = 0) {
    const w = this.workspaces[index],
      id = await this.db.listing(w.id, w.owner, w.agents[0].id);
    await this.db.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE listings SET status='published',published_at=clock_timestamp(),minimum_household_net_income=2000 WHERE id=$1`,
        [id],
      );
    });
    return id;
  }
  events(listingId: string) {
    return this.db.prisma.auditEvent.findMany({
      where: { listingId },
      include: { actorIdentity: true },
      orderBy: { recordedAt: 'asc' },
    });
  }
  async fail<T>(
    action: keyof LifecyclePayloads,
    work: () => Promise<T>,
    workspaceId?: string,
  ) {
    if (!/^[a-z_.]+$/.test(action)) throw new Error('Unsafe test action');
    if (workspaceId && !/^[0-9a-f-]{36}$/i.test(workspaceId))
      throw new Error('Unsafe test workspace');
    const workspacePredicate = workspaceId
      ? ` AND NEW.workspace_id='${workspaceId}'::uuid`
      : '';
    await this.db.pool
      .query(`CREATE FUNCTION test_fail_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Injected Audit persistence failure' USING ERRCODE='23514';END$$;
   CREATE TRIGGER test_fail_lifecycle_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN(NEW.action='${action}'${workspacePredicate}) EXECUTE FUNCTION test_fail_lifecycle_audit()`);
    try {
      return await work();
    } finally {
      await this.db.pool.query(
        'DROP TRIGGER test_fail_lifecycle_audit ON audit_events;DROP FUNCTION test_fail_lifecycle_audit()',
      );
    }
  }
}
