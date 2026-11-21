import type { Prisma } from '../../generated/prisma/client';

// Extends the existing production role verifier; no second startup hook.
export async function assertAuditRuntime(db: Prisma.TransactionClient) {
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT count(*)=1 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
      AND NOT pg_has_role(current_user,c.relowner,'MEMBER')
      AND NOT has_table_privilege(current_user,c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
      AND NOT has_function_privilege(current_user,'append_audit_event(jsonb)','EXECUTE')
      AND NOT has_function_privilege(current_user,'guard_audit_event_insert()','EXECUTE')
      AND NOT has_function_privilege(current_user,'reject_audit_event_mutation()','EXECUTE') AS safe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='audit_events'`;
  if (!row?.safe)
    throw new Error('Application audit runtime boundary is unsafe');
}
