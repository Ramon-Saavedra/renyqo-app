import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client';
import { runSerializableTransaction } from '../src/prisma/run-serializable-transaction';
import { MembershipIdentityRepository } from '../src/provider-workspaces/persistence/membership-identity.repository';
import { OrganizationProfileRepository } from '../src/provider-workspaces/persistence/organization-profile.repository';
import { PersonalAllocationRepository } from '../src/provider-workspaces/persistence/personal-allocation.repository';
import { WorkspaceRepository } from '../src/provider-workspaces/persistence/workspace.repository';
import { WorkspaceConversion } from '../src/provider-workspaces/workspace-conversion';
import {
  WorkspaceEstablishment,
  type EstablishWorkspace,
} from '../src/provider-workspaces/workspace-establishment';
import { WorkspaceLifecycle } from '../src/provider-workspaces/workspace-lifecycle';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

export class WorkspaceFixture {
  readonly schema = `workspace_${randomUUID().replaceAll('-', '')}`;
  admin!: Pool;
  pool!: Pool;
  prisma!: PrismaClient;
  readonly workspaces = new WorkspaceRepository();
  readonly profiles = new OrganizationProfileRepository();
  readonly establishment = new WorkspaceEstablishment(
    this.workspaces,
    new MembershipIdentityRepository(),
    new PersonalAllocationRepository(),
    this.profiles,
  );
  readonly conversion = new WorkspaceConversion(this.workspaces, this.profiles);
  readonly lifecycle = new WorkspaceLifecycle(this.workspaces);

  async start() {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
      throw new Error(
        'Dedicated E2E database and explicit reset marker required',
      );
    assertSafeE2EDatabaseUrl(url);
    this.admin = new Pool({ connectionString: url, max: 1 });
    const setup = await this.admin.connect();
    try {
      await setup.query(`CREATE SCHEMA "${this.schema}"`);
      await setup.query(`SET search_path TO "${this.schema}"`);
      const root = resolve(process.cwd(), 'prisma/migrations');
      for (const name of readdirSync(root).sort()) {
        if (name === 'migration_lock.toml') continue;
        await setup.query(
          readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
        );
      }
    } finally {
      setup.release();
    }
    this.pool = new Pool({
      connectionString: url,
      options: `-c search_path=${this.schema}`,
      max: 8,
    });
    this.prisma = new PrismaClient({
      adapter: new PrismaPg(this.pool, { schema: this.schema }),
    });
    await this.prisma.$connect();
  }

  async stop() {
    await this.prisma?.$disconnect();
    await this.pool?.end();
    if (this.admin) {
      if (!/^workspace_[a-f0-9]{32}$/.test(this.schema))
        throw new Error('Unsafe schema cleanup');
      await this.admin.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
      await this.admin.end();
    }
  }

  tx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return runSerializableTransaction(this.prisma, work);
  }

  async sqlTransaction(work: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async user() {
    const id = randomUUID();
    await this.prisma.user.create({
      data: {
        id,
        name: 'Workspace user',
        email: `${id}@workspace.test`,
        passwordHash: 'not-a-login',
        acceptedTermsAt: new Date(),
        acceptedPrivacyAt: new Date(),
      },
    });
    return id;
  }

  command(
    userId: string,
    kind: 'PERSONAL' | 'ORGANIZATION' = 'PERSONAL',
  ): EstablishWorkspace {
    const common = {
      workspaceId: randomUUID(),
      membershipId: randomUUID(),
      userId,
      displayName: 'Workspace',
    };
    return kind === 'PERSONAL'
      ? { ...common, kind, allocationId: randomUUID() }
      : { ...common, kind, legalName: 'Agency GmbH' };
  }

  establish(command: EstablishWorkspace) {
    return this.tx((tx) => this.establishment.withinTransaction(tx, command));
  }

  async close(id: string, revision = 1) {
    await this.tx((tx) =>
      this.lifecycle.beginClosingWithinTransaction(tx, id, revision),
    );
    return this.tx((tx) =>
      this.lifecycle.completeClosureWithinTransaction(tx, id, revision + 1),
    );
  }
}
