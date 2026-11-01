import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

jest.setTimeout(120000);

describe('Profile eligibility migration (isolated PostgreSQL)', () => {
  const migration = '20261101180000_profile_eligibility_assessments';
  const schemas = ['zero', 'upgrade'].map(
    (mode) => `prequal_${mode}_${randomUUID().replaceAll('-', '')}`,
  );
  const created: string[] = [];
  let pool: Pool;

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const schema of created) {
        if (!/^prequal_(zero|upgrade)_[a-f0-9]{32}$/.test(schema))
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
    expect(migrations.at(-1)).toBe(migration);
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
          for (const name of migrations.filter((n) => n !== migration))
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
          const before = (await client.query('SELECT * FROM applications'))
            .rows;
          await client.query(
            readFileSync(resolve(root, migration, 'migration.sql'), 'utf8'),
          );
          expect(
            (await client.query('SELECT * FROM applications')).rows,
          ).toEqual(before);
          expect(
            (
              await client.query<{ n: number }>(
                'SELECT count(*)::int n FROM listing_criteria_revisions',
              )
            ).rows[0].n,
          ).toBe(0);
          expect(
            (
              await client.query<{ n: number }>(
                'SELECT count(*)::int n FROM application_eligibility_assessments',
              )
            ).rows[0].n,
          ).toBe(0);
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
});
