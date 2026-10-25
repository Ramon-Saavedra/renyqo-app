import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/** Caller owns authorization and Serializable retries; shares listing/application locks. */
@Injectable()
export class ApplicationConsiderationService {
  async outcomeWithinTransaction(
    tx: Prisma.TransactionClient,
    input: {
      applicationId: string;
      listingId: string;
      outcomeId: string;
      previousOutcomeId?: string;
      penalize: boolean;
      now: Date;
    },
  ) {
    await tx.$queryRaw`SELECT id FROM listings WHERE id=${input.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${input.applicationId}::uuid FOR UPDATE`;
    if (input.previousOutcomeId) {
      const effect = await tx.applicationNoShowConsequence.findUnique({
        where: { outcomeId: input.previousOutcomeId },
      });
      if (effect && !effect.correctedByOutcomeId) {
        const app = await tx.application.findUniqueOrThrow({
          where: { id: input.applicationId },
          select: { status: true },
        });
        const restored =
          app.status === 'ACTIVE'
            ? await tx.applicationConsiderationPosition.updateMany({
                where: {
                  applicationId: input.applicationId,
                  position: effect.appliedPosition,
                  revision: effect.appliedRevision,
                },
                data: {
                  position: effect.previousPosition,
                  revision: { increment: 1 },
                },
              })
            : { count: 0 };
        await tx.applicationNoShowConsequence.update({
          where: { outcomeId: effect.outcomeId },
          data: {
            correctedByOutcomeId: input.outcomeId,
            correctedAt: input.now,
            positionRestored: restored.count === 1,
          },
        });
      }
    }
    if (!input.penalize) return;
    const previous =
      await tx.applicationConsiderationPosition.findUniqueOrThrow({
        where: { applicationId: input.applicationId },
      });
    const [allocation] = await tx.$queryRaw<
      { position: bigint }[]
    >`SELECT nextval(pg_get_serial_sequence('application_consideration_positions','position')) AS position`;
    const updated = await tx.applicationConsiderationPosition.update({
      where: { applicationId: input.applicationId },
      data: { position: allocation.position, revision: { increment: 1 } },
    });
    await tx.applicationNoShowConsequence.create({
      data: {
        outcomeId: input.outcomeId,
        applicationId: input.applicationId,
        listingId: input.listingId,
        previousPosition: previous.position,
        appliedPosition: updated.position,
        appliedRevision: updated.revision,
      },
    });
  }
}
