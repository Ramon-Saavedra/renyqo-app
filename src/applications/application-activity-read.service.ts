import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationActivityVisibility } from '../generated/prisma/enums';
import type { AttentionAudience } from '../application-attention/application-pending-action';
import { toPublicActivityPayload } from './application-activity.policy';

const select = {
  id: true,
  type: true,
  actorType: true,
  occurredAt: true,
  payload: true,
} satisfies Prisma.ApplicationActivitySelect;
type Row = Prisma.ApplicationActivityGetPayload<{ select: typeof select }>;

@Injectable()
export class ApplicationActivityReadService {
  scope(
    applicationId: string,
    audience: AttentionAudience,
  ): Prisma.ApplicationActivityWhereInput {
    return {
      applicationId,
      visibility: {
        in: [
          ApplicationActivityVisibility.BOTH,
          audience === 'provider'
            ? ApplicationActivityVisibility.PROVIDER
            : ApplicationActivityVisibility.APPLICANT,
        ],
      },
    };
  }

  toDto(row: Row) {
    return {
      id: row.id,
      type: row.type,
      actorType: row.actorType,
      occurredAt: row.occurredAt,
      payload: toPublicActivityPayload(row.payload),
    };
  }

  async preview(
    tx: Prisma.TransactionClient,
    applicationId: string,
    audience: AttentionAudience,
  ) {
    const rows = await tx.applicationActivity.findMany({
      where: this.scope(applicationId, audience),
      select,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 6,
    });
    return {
      items: rows.slice(0, 5).map((row) => this.toDto(row)),
      hasMore: rows.length > 5,
    };
  }

  page(
    tx: Prisma.TransactionClient,
    where: Prisma.ApplicationActivityWhereInput,
    limit: number,
  ) {
    return tx.applicationActivity.findMany({
      where,
      select,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  }
}
