import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
@Injectable()
export class ActorSnapshotCapture {
  async capture(
    tx: Prisma.TransactionClient,
    actor: Pick<
      AuthorizationContext,
      'workspaceId' | 'membershipId' | 'userId'
    >,
  ): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.member_actor_snapshot',build_member_actor_snapshot(${actor.workspaceId}::uuid,${actor.membershipId}::uuid,${actor.userId}::uuid)::text,true),set_config('app.member_actor_xid',pg_current_xact_id()::text,true)`;
  }
}
