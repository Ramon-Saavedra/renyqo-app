import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';
import {
  LISTING_WORKSPACE_CUTOVER_MIGRATION,
  clearLegacyListingsBeforeWorkspaceCutover,
} from './e2e-migration-cutover';

jest.setTimeout(120000);

describe('Verification requirement migration (isolated PostgreSQL)', () => {
  const migration = '20261101204015_verification_requirement_domain';
  const schemas = ['zero', 'upgrade'].map(
    (mode) => `verify_migration_${mode}_${randomUUID().replaceAll('-', '')}`,
  );
  const created: string[] = [];
  let pool: Pool;

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const schema of created) {
        if (!/^verify_migration_(zero|upgrade|bad)_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe schema');
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  });

  function cli(url: string, args: string[]) {
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', ...args],
      {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 90000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Prisma ${args.join(' ')} failed: ${result.stdout}\n${result.stderr}`,
      );
    return result.stdout;
  }

  async function catalog(client: PoolClient, schema: string) {
    await client.query(`SET search_path TO "${schema}"`);
    const columns = (
      await client.query(
        "SELECT table_name,column_name,data_type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema=$1 AND table_name<>'_prisma_migrations' ORDER BY table_name,ordinal_position",
        [schema],
      )
    ).rows;
    const constraints = (
      await client.query(
        "SELECT r.relname,c.conname,c.contype,pg_get_constraintdef(c.oid,true) definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=$1 AND r.relname<>'_prisma_migrations' ORDER BY r.relname,c.conname",
        [schema],
      )
    ).rows;
    const indexes = (
      await client.query(
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename<>'_prisma_migrations' ORDER BY tablename,indexname",
        [schema],
      )
    ).rows;
    const triggers = (
      await client.query(
        'SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname',
        [schema],
      )
    ).rows;
    return JSON.stringify({
      columns,
      constraints,
      indexes,
      triggers,
    }).replaceAll(schema, 'SCHEMA');
  }

  it('deploys from zero, upgrades existing data without historical backfill, and produces identical schemas with no Prisma drift', async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url) throw new Error('E2E_DATABASE_URL required');
    assertSafeE2EDatabaseUrl(url);
    pool = new Pool({ connectionString: url, max: 2 });
    const root = resolve('prisma/migrations');
    const migrations = readdirSync(root)
      .filter((n) => n !== 'migration_lock.toml')
      .sort();
    expect(migrations).toContain(migration);
    const catalogs: string[] = [];
    for (const [index, schema] of schemas.entries()) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
      const scoped = new URL(url);
      scoped.searchParams.set('schema', schema);
      const client = await pool.connect();
      try {
        if (index === 0) {
          cli(scoped.href, ['migrate', 'deploy']);
          cli(scoped.href, ['migrate', 'status']);
        } else {
          await client.query(`SET search_path TO "${schema}"`);
          for (const name of migrations.filter((n) => n < migration))
            await client.query(
              readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
            );
          const provider = randomUUID(),
            applicant = randomUUID(),
            listing = randomUUID(),
            application = randomUUID();
          for (const id of [provider, applicant])
            await client.query(
              "INSERT INTO users(id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Migration fixture',$2,'unused',now(),now(),now())",
              [id, `${id}@migration.test`],
            );
          await client.query(
            "INSERT INTO listings(id,provider_id,title,display_order,updated_at) VALUES($1,$2,'Existing listing',1,now())",
            [listing, provider],
          );
          await client.query(
            "INSERT INTO applications(id,listing_id,applicant_id,status,updated_at) VALUES($1,$2,$3,'waiting',now())",
            [application, listing, applicant],
          );
          const open = randomUUID(),
            closed = randomUUID(),
            file = randomUUID();
          await client.query(
            "INSERT INTO application_document_requests(id,application_id,type,logical_key,round) VALUES($1,$2,'income_proof','INCOME_PROOF',1)",
            [open, application],
          );
          await client.query(
            "INSERT INTO application_document_requests(id,application_id,type,logical_key,round,superseded_at) VALUES($1,$2,'schufa','SCHUFA',1,'2026-09-01T10:00:00Z')",
            [closed, application],
          );
          await client.query(
            "INSERT INTO application_document_files(id,request_id,storage_key,bucket,checksum,mime_type,size,state,recover_after,expires_at,available_at,reviewed_at) VALUES($1,$2,'legacy-key','legacy-bucket','checksum','application/pdf',100,'available',now(),now(),now(),now())",
            [file, open],
          );
          await client.query(
            'UPDATE application_document_requests SET current_file_id=$1 WHERE id=$2',
            [file, open],
          );
          const originalFiles = (
            await client.query('SELECT * FROM application_document_files')
          ).rows;
          const before = (await client.query('SELECT * FROM applications'))
            .rows;
          await client.query(
            readFileSync(resolve(root, migration, 'migration.sql'), 'utf8'),
          );
          const after = (await client.query('SELECT * FROM applications')).rows;
          expect(
            after.map(
              ({
                verification_scope_revision,
                ...rest
              }: Record<string, unknown>) => {
                expect(verification_scope_revision).toBe(0);
                return rest;
              },
            ),
          ).toEqual(before);
          expect(
            (await client.query('SELECT * FROM application_document_files'))
              .rows,
          ).toEqual(originalFiles);
          const requests = (
            await client.query<{
              id: string;
              lifecycle_state: string;
              provenance: string;
              created_by_user_id: string | null;
              predecessor_id: string | null;
              created_scope_revision: number | null;
              closed_at: Date | null;
              superseded_at: Date | null;
            }>('SELECT * FROM application_document_requests')
          ).rows;
          expect(requests.find((r) => r.id === open)).toMatchObject({
            lifecycle_state: 'OPEN',
            provenance: 'LEGACY',
            created_by_user_id: null,
            predecessor_id: null,
            created_scope_revision: null,
            closed_at: null,
          });
          expect(requests.find((r) => r.id === closed)).toMatchObject({
            lifecycle_state: 'LEGACY_CLOSED_UNKNOWN',
            provenance: 'LEGACY',
            created_by_user_id: null,
            predecessor_id: null,
            created_scope_revision: null,
            closed_at: new Date('2026-09-01T10:00:00Z'),
          });
          expect(
            (
              await client.query<{ n: number }>(
                'SELECT count(*)::int n FROM verification_command_receipts',
              )
            ).rows[0].n,
          ).toBe(0);
        }
        if (index === 1)
          for (const name of migrations.filter((n) => n > migration)) {
            if (name === LISTING_WORKSPACE_CUTOVER_MIGRATION) {
              await clearLegacyListingsBeforeWorkspaceCutover(client);
            }
            await client.query(
              readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
            );
          }
        const diff = cli(scoped.href, [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--script',
          '--exit-code',
        ]);
        expect(diff.trim()).toBe('-- This is an empty migration.');
        catalogs.push(await catalog(client, schema));
      } finally {
        client.release();
      }
    }
    expect(catalogs[0]).toBe(catalogs[1]);
  });
  it('fails preflight with exact offending request IDs and leaves existing data untouched', async () => {
    const schema = `verify_migration_bad_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created.push(schema);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      const root = resolve('prisma/migrations');
      for (const name of readdirSync(root)
        .filter((n) => n !== 'migration_lock.toml' && n < migration)
        .sort())
        await client.query(
          readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
        );
      const user = randomUUID(),
        listing = randomUUID(),
        application = randomUUID(),
        a = randomUUID(),
        b = randomUUID(),
        file = randomUUID();
      await client.query(
        "INSERT INTO users(id,name,email,password_hash,accepted_terms_at,accepted_privacy_at,updated_at) VALUES($1,'Preflight',$2,'unused',now(),now(),now())",
        [user, `${user}@migration.test`],
      );
      await client.query(
        'INSERT INTO listings(id,provider_id,display_order,updated_at) VALUES($1,$2,1,now())',
        [listing, user],
      );
      await client.query(
        'INSERT INTO applications(id,listing_id,applicant_id,updated_at)VALUES($1,$2,$3,now())',
        [application, listing, user],
      );
      for (const [id, key] of [
        [a, 'SCHUFA'],
        [b, 'INCOME_PROOF'],
      ])
        await client.query(
          "INSERT INTO application_document_requests(id,application_id,type,logical_key,round)VALUES($1,$2,'schufa',$3,1)",
          [id, application, key],
        );
      await client.query(
        "INSERT INTO application_document_files(id,request_id,storage_key,bucket,checksum,mime_type,size,state,recover_after,expires_at)VALUES($1,$2,'preflight-key','bucket','hash','application/pdf',100,'processing',now(),now())",
        [file, b],
      );
      await client.query(
        'UPDATE application_document_requests SET current_file_id=$1 WHERE id=$2',
        [file, a],
      );
      const before = (
        await client.query(
          'SELECT * FROM application_document_requests ORDER BY id',
        )
      ).rows;
      await expect(
        client.query(
          readFileSync(resolve(root, migration, 'migration.sql'), 'utf8'),
        ),
      ).rejects.toThrow(a);
      await client.query('ROLLBACK');
      expect(
        (
          await client.query(
            'SELECT * FROM application_document_requests ORDER BY id',
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await client.query<{ n: number }>(
            "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND column_name='subject_id'",
            [schema],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      client.release();
    }
  });
});
