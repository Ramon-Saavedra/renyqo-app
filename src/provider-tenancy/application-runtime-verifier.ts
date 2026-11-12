import type { Prisma } from '../generated/prisma/client';
import { assertRestrictedWorkspaceRuntime } from './runtime-role-verifier';
import grantMatrix from './application-runtime-grants.json';

// Activated only by the coordinated 4.5.5 operational Listing cutover. Unlike
// the workspace-only login, this login must also support existing app modules.
export async function assertApplicationRuntime(
  db: Prisma.TransactionClient,
  expectedSchema?: string,
) {
  await assertRestrictedWorkspaceRuntime(db);
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT pg_has_role(current_user,'renyqo_application_runtime','MEMBER')
      AND NOT pg_has_role(current_user,'renyqo_applicant_listing_resolver','MEMBER')
      AND (SELECT count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
        AND NOT pg_has_role(current_user,c.relowner,'MEMBER')
        AND NOT has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
        AND c.relname IN('listings','listing_assignment_transitions','listing_transfer_requests'))
      AND NOT has_table_privilege(current_user,'public_listing_projections','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      AND has_table_privilege(current_user,'users','SELECT')
      AND has_table_privilege(current_user,'users','INSERT')
      AND has_table_privilege(current_user,'users','UPDATE')
      AND has_table_privilege(current_user,'user_sessions','SELECT')
      AND has_table_privilege(current_user,'user_sessions','INSERT')
      AND has_table_privilege(current_user,'user_sessions','UPDATE')
      AND has_table_privilege(current_user,'user_sessions','DELETE')
      AND has_table_privilege(current_user,'session_auth_grants','SELECT')
      AND has_table_privilege(current_user,'session_auth_grants','INSERT')
      AND has_table_privilege(current_user,'session_auth_grants','DELETE')
      AND has_table_privilege(current_user,'outbox_events','SELECT')
      AND has_table_privilege(current_user,'outbox_events','INSERT')
      AND has_table_privilege(current_user,'outbox_events','UPDATE')
      AND has_table_privilege(current_user,'outbox_events','DELETE')
      AND has_table_privilege(current_user,'application_document_files','SELECT')
      AND has_table_privilege(current_user,'application_document_files','INSERT')
      AND has_table_privilege(current_user,'application_document_files','UPDATE') AS safe`;
  if (!row?.safe)
    throw new Error(
      'Application runtime credential is not ready for Listing cutover',
    );
  const tables: string[] = [];
  const privileges: string[] = [];
  for (const [permissions, relations] of Object.entries(grantMatrix))
    for (const relation of relations)
      for (const permission of permissions.split(',')) {
        tables.push(relation);
        privileges.push(permission);
      }
  const [grants] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT bool_and(has_table_privilege(current_user,format('%I.%I',current_schema(),expected.relation),expected.privilege))
      AND (${expectedSchema ?? null}::text IS NULL OR current_schema()=${expectedSchema ?? null}::text)
      AND NOT has_database_privilege(current_user,current_database(),'CREATE')
      AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND pg_has_role(current_user,c.relowner,'MEMBER'))
      AND NOT has_table_privilege(current_user,'listing_tenant_routes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      AND NOT EXISTS(SELECT FROM pg_roles p WHERE p.rolname NOT IN(current_user,'renyqo_application_runtime','renyqo_workspace_runtime')
        AND pg_has_role(current_user,p.oid,'MEMBER'))
      AND (pg_get_serial_sequence('applications','queue_order') IS NULL OR
        has_sequence_privilege(current_user,pg_get_serial_sequence('applications','queue_order'),'USAGE'))
      AND (pg_get_serial_sequence('application_consideration_positions','position') IS NULL OR
        has_sequence_privilege(current_user,pg_get_serial_sequence('application_consideration_positions','position'),'USAGE')) AS safe
    FROM unnest(${tables}::text[],${privileges}::text[]) AS expected(relation,privilege)`;
  if (!grants?.safe)
    throw new Error(
      'Application runtime required privileges are missing or excessive',
    );
}
