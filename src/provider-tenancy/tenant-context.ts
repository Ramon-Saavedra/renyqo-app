import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopes = new WeakMap<object, string>();

// Only call with an interactive transaction client. Context is not authority.
export async function installTenantContext(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  if (!uuid.test(workspaceId))
    throw new NotFoundException('Workspace not found');
  const id = workspaceId.toLowerCase();
  const prior = scopes.get(tx);
  if (prior && prior !== id)
    throw new Error('Cannot switch tenant transaction');
  const [current] = await tx.$queryRaw<{ id: string | null }[]>`
    SELECT current_workspace_id()::text AS id`;
  if (current?.id && current.id !== id)
    throw new Error('Cannot switch tenant transaction');
  await tx.$queryRaw`
    SELECT set_config('app.workspace_id', ${id}, true),
      set_config('app.tenant_xid', pg_current_xact_id()::text, true),
      set_config('app.bootstrap_user_id', '', true),
      set_config('app.bootstrap_workspace_id', '', true)`;
  scopes.set(tx, id);
}

export async function installMembershipBootstrap(
  tx: Prisma.TransactionClient,
  userId: string,
  workspaceId: string,
): Promise<void> {
  if (!uuid.test(userId) || !uuid.test(workspaceId))
    throw new NotFoundException('Workspace not found');
  if (scopes.has(tx)) throw new Error('Cannot bootstrap a scoped transaction');
  const [current] = await tx.$queryRaw<{ id: string | null }[]>`
    SELECT current_workspace_id()::text AS id`;
  if (current?.id) throw new Error('Cannot bootstrap a scoped transaction');
  await tx.$queryRaw`
    SELECT set_config('app.workspace_id', '', true),
      set_config('app.tenant_xid', pg_current_xact_id()::text, true),
      set_config('app.bootstrap_user_id', ${userId.toLowerCase()}, true),
      set_config('app.bootstrap_workspace_id', ${workspaceId.toLowerCase()}, true)`;
}
