import type { Prisma } from '../../generated/prisma/client';

// Extends the existing production role verifier; no second startup hook.
export async function assertAuditRuntime(db: Prisma.TransactionClient) {
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
      AND NOT pg_has_role(current_user,c.relowner,'MEMBER')
      AND NOT has_table_privilege(current_user,c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
      AND NOT has_function_privilege(current_user,'append_audit_event(jsonb)','EXECUTE')
      AND NOT has_function_privilege(current_user,'guard_audit_event_insert()','EXECUTE')
      AND NOT has_function_privilege(current_user,'reject_audit_event_mutation()','EXECUTE')
      AND NOT has_function_privilege(current_user,'open_system_audit_execution(uuid,text,jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'open_human_audit_execution(uuid,uuid,integer,text,text,uuid,integer,uuid,jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'append_context_audit_event(uuid,text,jsonb,jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'close_audit_execution(uuid)','EXECUTE')
      AND has_function_privilege(current_user,'assert_audit_execution_complete()','EXECUTE')
      AND has_function_privilege(current_user,'query_workspace_audit(uuid,uuid,text,integer,integer,timestamptz,uuid)','EXECUTE')
      AND (SELECT count(*)=11 AND bool_and(NOT EXISTS(
        SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname=current_schema() AND p.proname IN(
          'reject_required_audit','audit_command_valid','create_audit_execution','assert_audit_execution_closed',
          'audit_human_valid','open_human_audit_execution','open_system_audit_execution',
          'append_context_audit_event','close_audit_execution','assert_audit_execution_complete','query_workspace_audit')) AS safe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname IN('audit_events','audit_actor_identities','audit_execution_contexts')`;
  if (!row?.safe)
    throw new Error('Application audit runtime boundary is unsafe');
}
