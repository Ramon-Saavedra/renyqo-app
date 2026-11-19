import type { Prisma } from '../src/generated/prisma/client';
import { ActorSnapshotCapture } from '../src/member-presentation/actor-snapshot.capture';
export class HistoricalActorSnapshotCapture extends ActorSnapshotCapture {
  override async capture(
    tx: Prisma.TransactionClient,
    actor: Parameters<ActorSnapshotCapture['capture']>[1],
  ): Promise<void> {
    const [{ installed }] = await tx.$queryRaw<
      { installed: boolean }[]
    >`SELECT to_regprocedure('build_member_actor_snapshot(uuid,uuid,uuid)') IS NOT NULL AS installed`;
    if (installed) await super.capture(tx, actor);
  }
}
