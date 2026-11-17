import type { Pool } from 'pg';
import type { Prisma } from '../src/generated/prisma/client';
export const testOrganizationPlan = '45700000-0000-4000-8000-000000009999';
// Test-only catalog, never shipped by a production migration or runtime adapter.
export async function seedEntitlementTestCatalog(pool: Pool) {
  await pool.query(
    `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats)
    VALUES($1,'TEST_FIXTURE',1,'ORGANIZATION',10000,1000) ON CONFLICT DO NOTHING`,
    [testOrganizationPlan],
  );
}
export async function assignEntitlementTestPlan(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  owner: string,
) {
  await tx.$executeRaw`UPDATE workspace_plan_assignments SET plan_version_id=${testOrganizationPlan}::uuid,source='INTERNAL',change_mode='VOLUNTARY',command_id=gen_random_uuid(),actor_membership_id=${owner}::uuid WHERE workspace_id=${workspaceId}::uuid AND plan_version_id IS NULL`;
}
