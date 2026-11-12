import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { WorkspaceFixture } from './provider-workspaces.fixture';

jest.setTimeout(30000);
describe('Canonical listing migration clean/upgrade parity', () => {
  const clean = new WorkspaceFixture();
  const upgrade = new WorkspaceFixture();
  const boundary = '20261108150000_listing_workspace_assignment';
  beforeAll(async () => {
    await clean.start(null);
    await upgrade.start(boundary);
    const root = join(process.cwd(), 'prisma/migrations');
    for (const name of readdirSync(root).sort()) {
      if (name === 'migration_lock.toml' || name < boundary) continue;
      await upgrade.pool.query(
        readFileSync(join(root, name, 'migration.sql'), 'utf8'),
      );
    }
  });
  afterAll(async () => {
    try {
      await clean.stop();
    } finally {
      await upgrade.stop();
    }
  });

  async function catalog(f: WorkspaceFixture) {
    const schema = f.schema;
    const tables = (
      await f.pool.query(
        `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS grants
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN('r','p','S','v') ORDER BY c.relname`,
        [schema],
      )
    ).rows as unknown[];
    const columns = (
      await f.pool.query(
        `SELECT c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attacl::text AS grants
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN('r','p','v')
      ORDER BY c.relname,a.attnum`,
        [schema],
      )
    ).rows as unknown[];
    const constraints = (
      await f.pool.query(
        `SELECT c.conname,c.conrelid::regclass::text AS relation,
      pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c
      JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 ORDER BY relation,c.conname`,
        [schema],
      )
    ).rows as unknown[];
    const indexes = (
      await f.pool.query(
        `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY indexname`,
        [schema],
      )
    ).rows as unknown[];
    const triggers = (
      await f.pool.query(
        `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
        [schema],
      )
    ).rows as unknown[];
    const policies = (
      await f.pool.query(
        `SELECT tablename,policyname,permissive,roles::text,cmd,qual,with_check
      FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`,
        [schema],
      )
    ).rows as unknown[];
    const functions = (
      await f.pool.query(
        `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl::text AS grants
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
      ORDER BY p.proname,arguments`,
        [schema],
      )
    ).rows as unknown[];
    const enums = (
      await f.pool.query(
        `SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 ORDER BY t.typname,e.enumsortorder`,
        [schema],
      )
    ).rows as unknown[];
    return JSON.parse(
      JSON.stringify({
        tables,
        columns,
        constraints,
        indexes,
        triggers,
        policies,
        functions,
        enums,
      }).replaceAll(schema, 'canonical_schema'),
    ) as unknown;
  }

  it('has no Prisma schema drift after a complete clean replay', () => {
    const url = new URL(process.env['E2E_DATABASE_URL']!);
    url.searchParams.set('schema', clean.schema);
    const diff = execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(
      diff
        .split(';')
        .map((statement) => statement.replace(/--[^\n]*/g, '').trim())
        .filter(Boolean),
    ).toEqual([]);
  });

  it('matches table shapes, enums, constraints, indexes, triggers, RLS, functions and privileges', async () => {
    expect(await catalog(upgrade)).toEqual(await catalog(clean));
  });
});
