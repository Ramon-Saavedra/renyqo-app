import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { AuditWriter } from '../src/audit/persistence/audit-writer';
import type { AuditEventInput } from '../src/audit/domain/audit-event';

export function auditEvent(workspaceId: string): AuditEventInput {
  return {
    id: randomUUID(),
    workspaceId,
    action: 'audit.ledger.activated',
    schemaVersion: 1,
    actor: { kind: 'SYSTEM', purpose: 'AUDIT_LEDGER_ACTIVATION' },
    resourceType: 'WORKSPACE',
    resourceId: workspaceId,
    occurredAt: new Date().toISOString(),
    source: 'INTERNAL',
    correlationId: randomUUID(),
    commandId: randomUUID(),
    commandScope: 'audit.ledger.activation',
    effectKey: 'activation',
    changes: {},
    metadata: { activationVersion: 1 },
  };
}

export class AuditFixture extends WorkspaceFixture {
  readonly runtimeLogin = `audit_runtime_${randomUUID().replaceAll('-', '')}`;
  readonly writerLogin = `audit_writer_${randomUUID().replaceAll('-', '')}`;
  runtimePool!: Pool;
  writerPool!: Pool;
  writerPrisma!: PrismaClient;
  runtimePrisma!: PrismaClient;
  a!: Awaited<ReturnType<WorkspaceFixture['command']>>;
  b!: typeof this.a;

  override async start() {
    await super.start(null);
    this.a = await this.workspace();
    this.b = await this.workspace();
    this.runtimePool = await this.login(
      this.runtimeLogin,
      'renyqo_workspace_runtime',
    );
    // Test-only simulation of a future trusted invariant adapter. This is NOT
    // the application runtime login or a production provisioning recommendation.
    this.writerPool = await this.login(
      this.writerLogin,
      'renyqo_workspace_invariants',
    );
    this.writerPrisma = new PrismaClient({
      adapter: new PrismaPg(this.writerPool, { schema: this.schema }),
    });
    this.runtimePrisma = new PrismaClient({
      adapter: new PrismaPg(this.runtimePool, { schema: this.schema }),
    });
  }
  private async login(name: string, role: string) {
    const password = randomUUID();
    await this.admin.query(
      `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${password}'`,
    );
    await this.admin.query(`GRANT ${role} TO "${name}"`);
    const url = new URL(process.env['E2E_DATABASE_URL']!);
    url.username = name;
    url.password = password;
    return new Pool({
      connectionString: url.toString(),
      options: `-c search_path=${this.schema}`,
      max: 1,
    });
  }
  private async workspace() {
    const command = this.command(await this.user(), 'ORGANIZATION');
    await this.tx(async (tx) => {
      await installTenantContext(tx, command.workspaceId);
      await this.establishment.withinTransaction(tx, command);
    });
    return command;
  }
  append(input: AuditEventInput) {
    return this.writerPrisma.$transaction(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      return new AuditWriter().append(tx, input);
    });
  }
  async sql<T>(
    pool: Pool,
    workspace: string | null,
    work: (c: PoolClient) => Promise<T>,
  ) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (workspace) await sqlTenant(c, workspace);
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
  override async stop() {
    await this.writerPrisma?.$disconnect();
    await this.runtimePrisma?.$disconnect();
    await this.writerPool?.end();
    await this.runtimePool?.end();
    try {
      for (const name of [this.writerLogin, this.runtimeLogin])
        await this.admin?.query(`DROP ROLE IF EXISTS "${name}"`);
    } finally {
      await super.stop();
    }
  }
}
