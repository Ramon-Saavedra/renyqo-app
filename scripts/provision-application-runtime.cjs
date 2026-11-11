const { Client } = require('pg');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const grantMatrix=require('../src/provider-tenancy/application-runtime-grants.json');
const quoteId = (value) => '"' + value.replaceAll('"', '""') + '"';
const quoteText = (value) => "'" + value.replaceAll("'", "''") + "'";

async function main() {
  const admin = new URL(process.env.MIGRATION_DATABASE_URL || '');
  const runtime = new URL(process.env.APPLICATION_DATABASE_URL || '');
  if (
    admin.hostname !== runtime.hostname ||
    admin.port !== runtime.port ||
    admin.pathname !== runtime.pathname ||
    admin.username === runtime.username ||
    !runtime.password
  )
    throw new Error(
      'Separate deployment and application credentials for the same database required',
    );
  const schema = runtime.searchParams.get('schema') || 'public';
  const login = decodeURIComponent(runtime.username);
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL standard_conforming_strings=on');
    await c.query(`SELECT set_config('search_path',$1,true)`, [
      quoteId(schema),
    ]);
    await c.query(
      readFileSync(
        resolve(__dirname, 'application-runtime-grants.sql'),
        'utf8',
      ),
    );
    for(const [privileges,tables] of Object.entries(grantMatrix)){
      if(privileges.split(',').some(p=>!['SELECT','INSERT','UPDATE','DELETE'].includes(p)))throw new Error('Invalid grant matrix');
      for(const table of tables){
        if(!/^[a-z_]+$/.test(table))throw new Error('Invalid table grant');
        await c.query(`GRANT ${privileges} ON ${quoteId(schema)}.${quoteId(table)} TO renyqo_application_runtime`);
      }
    }
    const existing = await c.query('SELECT FROM pg_roles WHERE rolname=$1', [
      login,
    ]);
    if (!existing.rowCount)
      await c.query(
        `CREATE ROLE ${quoteId(login)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
    const [safe] = (
      await c.query(
        `SELECT rolcanlogin AND rolinherit AND NOT(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND NOT EXISTS(SELECT FROM pg_roles p WHERE p.rolname<>$1 AND p.rolname NOT IN('renyqo_application_runtime','renyqo_workspace_runtime')
    AND pg_has_role($1,p.oid,'MEMBER')) safe FROM pg_roles WHERE rolname=$1`,
        [login],
      )
    ).rows;
    if (!safe?.safe) throw new Error('Unsafe existing application role');
    await c.query(
      `ALTER ROLE ${quoteId(login)} PASSWORD ${quoteText(decodeURIComponent(runtime.password))}`,
    );
    await c.query(`GRANT renyqo_application_runtime TO ${quoteId(login)}`);
    // All API, session-store and worker pools must resolve the same configured
    // schema, including existing parameterized SQL that uses unqualified names.
    const database=decodeURIComponent(runtime.pathname.slice(1));
    await c.query(`ALTER ROLE ${quoteId(login)} IN DATABASE ${quoteId(database)} SET search_path TO ${quoteId(schema)}`);
    const [access] = (
      await c.query(
        `SELECT NOT has_database_privilege($1,current_database(),'CREATE') AND NOT has_schema_privilege($1,$2,'CREATE') AND NOT EXISTS(
    SELECT FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$2 AND
    (pg_has_role($1,t.relowner,'MEMBER') OR has_table_privilege($1,t.oid,'TRUNCATE,TRIGGER'))) safe`,
        [login, schema],
      )
    ).rows;
    if (!access?.safe) throw new Error('Unsafe application object privileges');
    await c.query('COMMIT');
    console.log(
      'Application runtime provisioned. Run restricted-login API/session/worker validation before coordinated activation.',
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
    'Application runtime provisioning failed; no credential fallback is permitted.',
  );
  process.exitCode = 1;
});
