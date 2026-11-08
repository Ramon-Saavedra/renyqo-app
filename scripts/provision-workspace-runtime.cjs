// Run explicitly AFTER migrations with a deployment/admin credential. Never
// invoke from application startup. No credentials are printed or persisted.
const { Client } = require('pg');
const ident = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

async function main() {
  const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL || '');
  const runtimeUrl = new URL(process.env.WORKSPACE_RUNTIME_DATABASE_URL || '');
  const schema = runtimeUrl.searchParams.get('schema') || 'public';
  if (
    adminUrl.hostname !== runtimeUrl.hostname ||
    adminUrl.port !== runtimeUrl.port ||
    adminUrl.pathname !== runtimeUrl.pathname ||
    adminUrl.username === runtimeUrl.username ||
    !runtimeUrl.password
  )
    throw new Error(
      'Distinct deployment/runtime credentials for the same database required',
    );
  const role = decodeURIComponent(runtimeUrl.username);
  const c = new Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL standard_conforming_strings=on');
    const exists = await c.query('SELECT FROM pg_roles WHERE rolname=$1', [
      role,
    ]);
    if (!exists.rowCount)
      await c.query(
        `CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
    const safe = await c.query(
      `SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
      AND rolcanlogin AND NOT EXISTS (SELECT FROM pg_roles p WHERE p.rolname<>$1 AND
        p.rolname<>'renyqo_workspace_runtime' AND pg_has_role($1,p.oid,'MEMBER')) AS safe FROM pg_roles WHERE rolname=$1`,
      [role],
    );
    if (!safe.rows[0]?.safe)
      throw new Error(
        'Existing runtime role has unsafe attributes/memberships',
      );
    await c.query(
      `ALTER ROLE ${ident(role)} PASSWORD ${literal(decodeURIComponent(runtimeUrl.password))}`,
    );
    await c.query(
      `GRANT CONNECT ON DATABASE ${ident(decodeURIComponent(adminUrl.pathname.slice(1)))} TO ${ident(role)}`,
    );
    await c.query(`GRANT renyqo_workspace_runtime TO ${ident(role)}`);
    // Foundation authority reads and row-lock permission only. Existing global
    // auth/legacy modules require their separately reviewed application grants.
    await c.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
    await c.query(
      `GRANT SELECT ON ${ident(schema)}.users,${ident(schema)}.user_sessions,${ident(schema)}.session_auth_grants TO ${ident(role)}`,
    );
    await c.query(
      `GRANT UPDATE(id) ON ${ident(schema)}.users TO ${ident(role)}`,
    );
    await c.query(
      `GRANT UPDATE(sid) ON ${ident(schema)}.session_auth_grants TO ${ident(role)}`,
    );
    const grants = await c.query(
      `SELECT NOT has_schema_privilege($1,$2,'CREATE')
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$2 AND c.relname IN ('provider_workspaces','workspace_memberships','organization_profiles',
          'ownership_transfer_intents','personal_workspace_allocations','workspace_ownership_revision_baselines')
        AND (pg_has_role($1,c.relowner,'MEMBER') OR has_table_privilege($1,c.oid,'TRUNCATE,DELETE,TRIGGER,REFERENCES')
          OR (c.relname='workspace_ownership_revision_baselines' AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE')))) AS safe`,
      [role, schema],
    );
    if (!grants.rows[0]?.safe)
      throw new Error('Unsafe existing runtime object grants');
    await c.query('COMMIT');
    console.log(
      'Workspace runtime login provisioned; verify application grants and runtime-role startup checks before rollout.',
    );
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    await c.end();
  }
}
main().catch(() => {
  console.error(
    'Workspace runtime provisioning failed; inspect role attributes and deployment permissions.',
  );
  process.exitCode = 1;
});
