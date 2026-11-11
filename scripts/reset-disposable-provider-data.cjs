const { Client } = require('pg');
const quoteId = value => '"' + value.replaceAll('"','""') + '"';
const allowed = new Set([
  'listings','listing_images','saved_listings','applications','application_viewings',
  'viewing_workflows','viewing_proposals','viewing_appointments','viewing_command_receipts',
  'application_viewing_outcomes','application_viewing_interests','application_consideration_positions',
  'application_no_show_consequences','listing_events','application_activities','notifications',
  'application_conversations','application_messages','application_document_requests',
  'application_document_files','listing_reports','listing_criteria_revisions',
  'application_eligibility_assessments','application_eligibility_checks',
  'application_verification_subjects','verification_decisions','verification_command_receipts',
]);

async function resetDisposableProviderData({connectionString,database,schema,apply=false}) {
  const url=new URL(connectionString);
  if(!database||decodeURIComponent(url.pathname.slice(1))!==database||!schema)
    throw new Error('Explicit matching maintenance database and schema required');
  const c=new Client({connectionString});await c.connect();
  try{
    await c.query('BEGIN');
    await c.query('SET LOCAL lock_timeout=\'5s\'');
    const target=(await c.query('SELECT current_database() AS database')).rows[0];
    if(target.database!==database)throw new Error('Unexpected maintenance database');
    const legacy=(await c.query(`SELECT FROM information_schema.columns WHERE table_schema=$1 AND table_name='listings' AND column_name='provider_id'`,[schema])).rowCount;
    if(!legacy)throw new Error('Reset is restricted to disposable pre-4.5.5 provider data');
    const root=`${quoteId(schema)}.listings`;
    const tables=(await c.query(`WITH RECURSIVE graph(oid) AS (
      SELECT $1::regclass::oid UNION SELECT k.conrelid FROM pg_constraint k JOIN graph g ON k.confrelid=g.oid WHERE k.contype='f'
    ) SELECT n.nspname AS schema,c.relname AS name FROM graph g JOIN pg_class c ON c.oid=g.oid
      JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY c.relname`,[root])).rows;
    if(tables.some(t=>t.schema!==schema||!allowed.has(t.name)))throw new Error('Unreviewed provider dependency: reset refused');
    if(tables.length!==allowed.size)throw new Error('Unexpected provider schema version: reset refused');
    const qualified=tables.map(t=>`${quoteId(schema)}.${quoteId(t.name)}`);
    await c.query(`LOCK TABLE ${qualified.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const counts=[];
    for(const table of tables){const count=(await c.query(`SELECT count(*)::text AS count FROM ${quoteId(schema)}.${quoteId(table.name)}`)).rows[0].count;counts.push({table:table.name,count});}
    if(!apply){await c.query('ROLLBACK');return {applied:false,counts};}
    await c.query(`DELETE FROM ${quoteId(schema)}.outbox_events o WHERE
      o.application_id IN(SELECT id FROM ${quoteId(schema)}.applications) OR
      o.conversation_id IN(SELECT id FROM ${quoteId(schema)}.application_conversations) OR
      o.payload->>'listingId' IN(SELECT id::text FROM ${root})`);
    // One explicit list satisfies cyclic/restrict FKs. No CASCADE, disabled
    // constraints, trigger changes, user/profile deletion or workspace reset.
    await c.query(`TRUNCATE TABLE ${qualified.join(', ')}`);
    await c.query('COMMIT');return {applied:true,counts};
  }catch(error){await c.query('ROLLBACK');throw error;}
  finally{await c.end();}
}
module.exports={resetDisposableProviderData};
if(require.main===module){
  const apply=process.env.PROVIDER_RESET_APPLY==='true';
  if(apply&&(process.env.ALLOW_DISPOSABLE_PROVIDER_RESET!=='4.5.5'||process.env.PROVIDER_WRITES_QUIESCED!=='true')){
    console.error('Explicit 4.5.5 reset authorization and quiesced writes required');process.exitCode=1;
  }else resetDisposableProviderData({connectionString:process.env.PROVIDER_RESET_DATABASE_URL,
    database:process.env.PROVIDER_RESET_DATABASE_NAME,schema:process.env.PROVIDER_RESET_SCHEMA,apply})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(()=>{console.error('Disposable provider reset refused or rolled back');process.exitCode=1;});
}
