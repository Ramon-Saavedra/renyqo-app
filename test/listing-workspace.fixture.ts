import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { TenantFixture } from './workspace-tenant.fixture';
import { assertApplicationRuntime } from '../src/provider-tenancy/application-runtime-verifier';
import { sqlTenant } from './workspace-tenant.fixture';
import { invitationMigrations } from './invitation-admission.fixture';
import { memberPresentationMigrations } from './member-presentation-migrations.fixture';
import {
  auditMigrations,
  auditContextMigrations,
  auditDomainMigrations,
  auditLifecycleMigrations,
} from './audit-migrations.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import {
  seedEntitlementTestCatalog,
  assignEntitlementTestPlan,
} from './entitlement-test-catalog';

export class ListingWorkspaceFixture extends TenantFixture {
  override async runtimeSql<T>(
    workspaceId: string | null,
    work: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (workspaceId) await sqlTenant(client, workspaceId);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  readonly applicationLogin = `app_${randomUUID().replaceAll('-', '')}`;
  applicationUrl!: string;
  applicationPool!: Pool;
  applicationRuntime!: PrismaClient;

  async workspaceFor(userId: string) {
    const input = this.command(userId, 'ORGANIZATION');
    await this.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await this.establishment.withinTransaction(tx, input);
      await tx.$executeRaw`SELECT lock_workspace_ownership_revision(${input.workspaceId}::uuid,1)`;
      await assignEntitlementTestPlan(
        tx,
        input.workspaceId,
        input.membershipId,
      );
    });
    return {
      id: input.workspaceId,
      owner: input.membershipId,
      ownerUser: userId,
    };
  }

  async activateApplication() {
    await this.activate();
    const migrations = 'prisma/migrations';
    for (const name of [
      '20261108150000_listing_workspace_assignment',
      '20261112150000_public_listing_discovery_indexes',
      '20261116100000_workspace_plan_catalog',
      '20261116101000_workspace_capacity_guards',
      '20261116102000_workspace_capacity_acquisition',
      '20261116103000_listing_creation_lineage',
      '20261116104000_workspace_plan_conversion',
      ...invitationMigrations,
      ...memberPresentationMigrations,
      ...auditMigrations,
      ...auditContextMigrations,
      ...auditDomainMigrations,
      ...auditLifecycleMigrations,
    ]) {
      try {
        await this.pool.query(
          readFileSync(join(migrations, name, 'migration.sql'), 'utf8'),
        );
      } catch (error) {
        throw new Error(
          `Migration ${name}: ${String(error)} ${JSON.stringify(error)}`,
          { cause: error },
        );
      }
    }
    await seedEntitlementTestCatalog(this.pool);
    const organizations = await this.prisma.providerWorkspace.findMany({
      where: { kind: 'ORGANIZATION' },
      include: { memberships: { where: { role: 'OWNER' } } },
    });
    for (const w of organizations)
      await this.tx(async (tx) => {
        await installTenantContext(tx, w.id);
        await tx.$executeRaw`SELECT lock_workspace_ownership_revision(${w.id}::uuid,${w.ownershipRevision})`;
        await assignEntitlementTestPlan(tx, w.id, w.memberships[0].id);
      });
    const admin = new URL(process.env['E2E_DATABASE_URL']!);
    admin.searchParams.set('schema', this.schema);
    const runtime = new URL(admin);
    runtime.username = this.applicationLogin;
    runtime.password = randomUUID();
    this.applicationUrl = runtime.toString();
    execFileSync(
      process.execPath,
      ['scripts/provision-application-runtime.cjs'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: admin.toString(),
          APPLICATION_DATABASE_URL: this.applicationUrl,
        },
        stdio: 'pipe',
      },
    );
    this.applicationPool = new Pool({
      connectionString: this.applicationUrl,
      options: `-c search_path=${this.schema}`,
      max: 8,
    });
    this.applicationRuntime = new PrismaClient({
      adapter: new PrismaPg(this.applicationPool, { schema: this.schema }),
    });
    await this.applicationRuntime.$connect();
    await assertApplicationRuntime(this.applicationRuntime);
  }

  async listing(
    workspaceId: string,
    creatorId: string,
    responsibleId = creatorId,
  ) {
    const id = randomUUID();
    await this.runtimeSql(workspaceId, async (c) => {
      const revision = (
        await c.query<{ ownership_revision: number }>(
          'SELECT ownership_revision FROM provider_workspaces WHERE id=$1',
          [workspaceId],
        )
      ).rows[0].ownership_revision;
      await c.query('SELECT lock_workspace_ownership_revision($1,$2)', [
        workspaceId,
        revision,
      ]);
      await c.query(
        `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,title,photos)
        VALUES($1,$2,$3,$4,(SELECT coalesce(max(display_order),0)+1 FROM listings WHERE workspace_id=$2),'Fixture Listing',ARRAY[]::text[])`,
        [id, workspaceId, creatorId, responsibleId],
      );
      await c.query(
        `INSERT INTO listing_assignment_transitions(id,workspace_id,listing_id,sequence,new_membership_id,reason,initiated_by_membership_id,command_id)
        VALUES($1,$2,$3,1,$4,'INITIAL',$5,$6)`,
        [randomUUID(), workspaceId, id, responsibleId, creatorId, randomUUID()],
      );
    });
    return id;
  }

  async applicationSql<T>(
    workspaceId: string | null,
    work: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.applicationPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (workspaceId) await sqlTenant(client, workspaceId);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  override async stop() {
    await this.applicationRuntime?.$disconnect();
    await this.applicationPool?.end();
    if (this.applicationRuntime) {
      await this.admin.query(`DROP OWNED BY "${this.applicationLogin}"`);
      await this.admin.query(`DROP ROLE "${this.applicationLogin}"`);
    }
    await super.stop();
  }
}
