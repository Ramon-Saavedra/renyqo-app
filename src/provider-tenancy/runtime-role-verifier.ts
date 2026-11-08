import type { Prisma } from '../generated/prisma/client';

export async function assertRestrictedWorkspaceRuntime(
  db: Prisma.TransactionClient,
) {
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
      AND r.rolcanlogin
      AND NOT has_schema_privilege(current_user,current_schema(),'CREATE')
      AND NOT pg_has_role(current_user,'renyqo_workspace_invariants','MEMBER')
      AND (SELECT count(*)=6 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
        AND NOT pg_has_role(current_user,c.relowner,'MEMBER')
        AND NOT has_table_privilege(current_user,c.oid,'TRUNCATE,DELETE,TRIGGER,REFERENCES'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname IN
          ('provider_workspaces','workspace_memberships','organization_profiles',
           'ownership_transfer_intents','personal_workspace_allocations','workspace_ownership_revision_baselines'))
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname='workspace_ownership_revision_baselines'
          AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRIGGER,REFERENCES'))
      AND NOT EXISTS (SELECT FROM pg_roles privileged WHERE
        (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolcreaterole)
        AND pg_has_role(current_user,privileged.oid,'MEMBER')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`;
  if (!row?.safe)
    throw new Error(
      'Unsafe PostgreSQL workspace runtime role or RLS configuration',
    );
}
