import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuthorizationFixture } from './provider-authorization.fixture';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { AuthorizedWorkspaceReads } from '../src/provider-authorization/authorized-workspace-reads';
import { TenantTransactions } from '../src/provider-tenancy/tenant-transactions';
import { assertRestrictedWorkspaceRuntime } from '../src/provider-tenancy/runtime-role-verifier';

export const rlsMigration = '20261108120000_workspace_tenant_rls';

export async function sqlTenant(c: PoolClient, workspaceId: string) {
  await c.query(
    `SELECT set_config('app.workspace_id',$1,true),
    set_config('app.tenant_xid',pg_current_xact_id()::text,true)`,
    [workspaceId],
  );
}

export class TenantFixture extends AuthorizationFixture {
  readonly login = `rls_${randomUUID().replaceAll('-', '')}`;
  runtimePool!: Pool;
  runtime!: PrismaClient;
  get tenant() {
    return new TenantTransactions(this.runtime as PrismaService);
  }
  override get writes() {
    return new ProtectedWorkspaceTransactions(
      this.runtime as PrismaService,
      this.authorityLocks,
      this.globalAuthority,
      this.resolver,
    );
  }
  override get reads() {
    return new AuthorizedWorkspaceReads(
      this.runtime as PrismaService,
      this.resolver,
    );
  }

  // Seed through the administrator before activation. All proof operations use
  // a new physical login, never SET ROLE from an administrator connection.
  async activate(max = 4) {
    const c = await this.pool.connect();
    try {
      await c.query(
        readFileSync(`prisma/migrations/${rlsMigration}/migration.sql`, 'utf8'),
      );
      await c.query('BEGIN');
      const password = randomUUID();
      await c.query(`CREATE ROLE "${this.login}" LOGIN PASSWORD '${password}'
        NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`);
      await c.query(`GRANT renyqo_workspace_runtime TO "${this.login}"`);
      await c.query(`GRANT SELECT ON users TO "${this.login}"`);
      await c.query(`GRANT UPDATE(id) ON users TO "${this.login}"`);
      await c.query(
        `GRANT SELECT ON user_sessions,session_auth_grants TO "${this.login}"`,
      );
      await c.query(
        `GRANT UPDATE(sid) ON session_auth_grants TO "${this.login}"`,
      );
      await c.query(
        `GRANT SELECT,INSERT,UPDATE ON authz_test_resources,authz_test_receipts TO "${this.login}"`,
      );
      await c.query('COMMIT');
      const url = new URL(process.env['E2E_DATABASE_URL']!);
      url.username = this.login;
      url.password = password;
      this.runtimePool = new Pool({
        connectionString: url.toString(),
        options: `-c search_path=${this.schema}`,
        max,
      });
      this.runtime = new PrismaClient({
        adapter: new PrismaPg(this.runtimePool, { schema: this.schema }),
      });
      await this.runtime.$connect();
      await assertRestrictedWorkspaceRuntime(this.runtime);
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  async runtimeSql<T>(
    workspaceId: string | null,
    work: (c: PoolClient) => Promise<T>,
  ) {
    const c = await this.runtimePool.connect();
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

  override async lock(c: PoolClient, workspaceId: string, revision = 1) {
    if (this.runtime) await sqlTenant(c, workspaceId);
    return super.lock(c, workspaceId, revision);
  }

  override async stop() {
    await this.runtime?.$disconnect();
    await this.runtimePool?.end();
    if (this.runtime) {
      await this.admin.query(`DROP OWNED BY "${this.login}"`);
      await this.admin.query(`DROP ROLE "${this.login}"`);
    }
    await super.stop();
  }

  scopedRead<T>(
    workspaceId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.tenant.run(workspaceId, work);
  }
}
