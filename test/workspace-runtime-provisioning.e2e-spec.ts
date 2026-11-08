import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { assertRestrictedWorkspaceRuntime } from '../src/provider-tenancy/runtime-role-verifier';
import { TenantFixture } from './workspace-tenant.fixture';

jest.setTimeout(30000);
describe('Deployment runtime login provisioning', () => {
  const f = new TenantFixture();
  beforeAll(async () => {
    await f.start();
    await f.activate();
  });
  afterAll(() => f.stop());

  it('provisions and idempotently reprovisions a minimum-grant login that passes the runtime exit gate', async () => {
    const role = `provision_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(process.env['E2E_DATABASE_URL']!);
    url.username = role;
    url.password = randomUUID() + "\\'quoted-secret";
    url.searchParams.set('schema', f.schema);
    const env = {
      ...process.env,
      MIGRATION_DATABASE_URL: process.env['E2E_DATABASE_URL'],
      WORKSPACE_RUNTIME_DATABASE_URL: url.toString(),
    };
    let db: PrismaClient | undefined;
    let pool: Pool | undefined;
    try {
      for (let i = 0; i < 2; i++)
        execFileSync(
          process.execPath,
          ['scripts/provision-workspace-runtime.cjs'],
          { env, stdio: 'pipe' },
        );
      pool = new Pool({
        connectionString: url.toString(),
        options: `-c search_path=${f.schema}`,
      });
      db = new PrismaClient({
        adapter: new PrismaPg(pool, { schema: f.schema }),
      });
      await assertRestrictedWorkspaceRuntime(db);
      await f.pool.query(`GRANT DELETE ON provider_workspaces TO "${role}"`);
      await expect(assertRestrictedWorkspaceRuntime(db)).rejects.toThrow(
        'Unsafe',
      );
      expect(() =>
        execFileSync(
          process.execPath,
          ['scripts/provision-workspace-runtime.cjs'],
          { env, stdio: 'pipe' },
        ),
      ).toThrow();
      await f.pool.query(`REVOKE DELETE ON provider_workspaces FROM "${role}"`);
      await assertRestrictedWorkspaceRuntime(db);
    } finally {
      await db?.$disconnect();
      await pool?.end();
      await f.admin.query(`DROP OWNED BY "${role}"`);
      await f.admin.query(`DROP ROLE "${role}"`);
    }
  });
});
