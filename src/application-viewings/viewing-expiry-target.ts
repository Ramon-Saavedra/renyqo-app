import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import type { ViewingClock } from './application-viewing.policy';
import type { ViewingExpiryTarget } from './viewing-workflow-expiry.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { installTenantContext } from '../provider-tenancy/tenant-context';
import { withApplicationLifecycleAudit } from '../applications/application-audit-boundary';

export function executeViewingExpiryTarget(
  deps: {
    prisma: PrismaService;
    clock: ViewingClock;
    lifecycle: ApplicationLifecycleService;
    proposal: (
      tx: Prisma.TransactionClient,
      applicationId: string,
      proposalId: string,
      now: Date,
    ) => Promise<boolean>;
  },
  target: ViewingExpiryTarget,
): Promise<boolean> {
  const commandId = randomUUID();
  return runSerializableTransaction(deps.prisma, async (tx) => {
    // Explicit SYSTEM purpose: only expiry of this canonical viewing target.
    // No revoked human authority is promoted into this worker path.
    const [ref] = await tx.$queryRaw<
      { listing_id: string; workspace_id: string }[]
    >`
        SELECT * FROM resolve_viewing_expiry_listing(${target.applicationId}::uuid,${target.id}::uuid,${target.kind}::text)`;
    if (!ref) return false;
    await installTenantContext(tx, ref.workspace_id);
    await tx.$queryRaw`SELECT id FROM provider_workspaces WHERE id=${ref.workspace_id}::uuid FOR SHARE`;
    const workspace = await tx.providerWorkspace.findUnique({
      where: { id: ref.workspace_id },
      select: { lifecycleStatus: true },
    });
    if (workspace?.lifecycleStatus !== 'ACTIVE') return false;
    // Never claim/lock a proposal before the established domain lock order.
    await tx.$queryRaw`SELECT id FROM listings WHERE id=${ref.listing_id}::uuid AND workspace_id=${ref.workspace_id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${target.applicationId}::uuid FOR UPDATE`;
    if (target.kind === 'proposal')
      return deps.proposal(
        tx,
        target.applicationId,
        target.id,
        deps.clock.now(),
      );
    return withApplicationLifecycleAudit(
      tx,
      { kind: 'SYSTEM' },
      commandId,
      [ref.listing_id],
      async () => {
        const now = deps.clock.now();
        const w = await tx.viewingWorkflow.findUnique({
          where: { applicationId: target.applicationId },
        });
        if (!w) return false;
        return deps.lifecycle.expireViewingInterestWithinTransaction(
          tx,
          target.applicationId,
          target.id,
          w.revision,
          now,
        );
      },
    );
  });
}
