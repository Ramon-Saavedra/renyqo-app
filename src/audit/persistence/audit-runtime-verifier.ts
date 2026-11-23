import type { Prisma } from '../../generated/prisma/client';

// Extends the existing production role verifier; no second startup hook.
export async function assertAuditRuntime(db: Prisma.TransactionClient) {
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT count(*)=7 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
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
      AND has_function_privilege(current_user,'append_domain_audit_event(uuid,text,text,uuid)','EXECUTE')
      AND has_function_privilege(current_user,'open_invitation_audit_execution(uuid,uuid,integer,text,jsonb)','EXECUTE')
      AND NOT has_function_privilege(current_user,'audit_invitation_evidence(audit_execution_contexts,text,uuid)','EXECUTE')
      AND NOT has_function_privilege(current_user,'audit_portfolio_evidence(audit_execution_contexts,text,uuid)','EXECUTE')
      AND has_function_privilege(current_user,'append_lifecycle_audit_event(uuid,text,jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'open_system_lifecycle_audit(uuid,jsonb,uuid)','EXECUTE')
      AND has_function_privilege(current_user,'open_profile_audit_scope(uuid,integer,text)','EXECUTE')
      AND has_function_privilege(current_user,'close_profile_audit_scope(uuid)','EXECUTE')
      AND NOT has_function_privilege(current_user,'audit_application_evidence(uuid)','EXECUTE')
      AND NOT has_function_privilege(current_user,'audit_listing_evidence(audit_execution_contexts,jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'audit_application_effect_refs(jsonb,uuid)','EXECUTE')
      AND (SELECT count(*)=31 AND bool_and(NOT EXISTS(
        SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname=current_schema() AND p.proname IN(
          'reject_required_audit','audit_command_valid','create_audit_execution','assert_audit_execution_closed',
          'audit_human_valid','open_human_audit_execution','open_system_audit_execution',
          'append_context_audit_event','close_audit_execution','assert_audit_execution_complete','query_workspace_audit',
          'audit_domain_payload_valid','audit_invitation_evidence','audit_portfolio_evidence',
          'append_domain_audit_event','open_invitation_audit_execution',
          'audit_workspace_allowed','assert_audit_scope','audit_profile_scope_closed','open_profile_audit_scope',
          'close_profile_audit_scope','audit_lifecycle_payload_valid','audit_application_evidence','open_system_lifecycle_audit',
          'audit_listing_evidence','append_lifecycle_audit_event',
          'capture_audit_activity_source','cleanup_audit_activity_source','audit_application_effect_refs',
          'capture_audit_application_change','cleanup_audit_application_change')) AS safe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname IN('audit_events','audit_actor_identities','audit_execution_contexts','audit_profile_scopes','audit_profile_bindings','audit_activity_sources','audit_application_changes')`;
  if (!row?.safe)
    throw new Error('Application audit runtime boundary is unsafe');
}
