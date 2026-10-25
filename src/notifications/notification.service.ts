import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxWriter } from '../outbox/outbox-writer.service';
import type { Prisma, Notification } from '../generated/prisma/client';
import { visibleNotifications } from './notification.policy';
import type { NotificationQueryDto } from './notification.dto';
import {
  notificationCategory,
  notificationTypesForCategory,
} from './notification-category';

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
  ) {}
  list(userId: string, query: NotificationQueryDto) {
    if (!!query.beforeId !== !!query.beforeCreatedAt)
      throw new BadRequestException('Both cursor fields are required');
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = new Date();
        const visible = visibleNotifications(userId, asOf);
        const cursor =
          query.beforeCreatedAt && query.beforeId
            ? {
                OR: [
                  { createdAt: { lt: new Date(query.beforeCreatedAt) } },
                  {
                    createdAt: new Date(query.beforeCreatedAt),
                    id: { lt: query.beforeId },
                  },
                ],
              }
            : {};
        const rows = await tx.notification.findMany({
          where: {
            AND: [
              visible,
              cursor,
              ...(query.category
                ? [
                    {
                      type: {
                        in: notificationTypesForCategory(query.category),
                      },
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit),
          last = page.at(-1);
        return {
          schemaVersion: 1,
          asOf,
          items: page.map(dto),
          unreadCount: await tx.notification.count({
            where: { AND: [visible, { readAt: null }] },
          }),
          nextRevalidateAt: (
            await tx.notification.aggregate({
              where: visible,
              _min: { expiresAt: true },
            })
          )._min.expiresAt,
          nextCursor:
            rows.length > query.limit && last
              ? { beforeCreatedAt: last.createdAt, beforeId: last.id }
              : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  unread(userId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = new Date(),
          visible = visibleNotifications(userId, asOf);
        return {
          asOf,
          unreadCount: await tx.notification.count({
            where: { AND: [visible, { readAt: null }] },
          }),
          nextRevalidateAt: (
            await tx.notification.aggregate({
              where: visible,
              _min: { expiresAt: true },
            })
          )._min.expiresAt,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  markRead(userId: string, notificationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date(),
        visible = visibleNotifications(userId, now);
      const row = await tx.notification.findFirst({
        where: { AND: [visible, { id: notificationId }] },
      });
      if (!row) throw new NotFoundException('Notification not found');
      const result = await tx.notification.updateMany({
        where: { AND: [visible, { id: notificationId, readAt: null }] },
        data: { readAt: now },
      });
      if (result.count) await this.changed(tx, userId, now);
      const current = await tx.notification.findFirst({
        where: { AND: [visible, { id: notificationId }] },
        select: { id: true, readAt: true },
      });
      if (!current) throw new NotFoundException('Notification not found');
      return { id: current.id, readAt: current.readAt };
    });
  }
  markAllRead(userId: string, throughCreatedAt: Date) {
    if (
      !Number.isFinite(throughCreatedAt.getTime()) ||
      throughCreatedAt > new Date()
    )
      throw new BadRequestException('Read snapshot cannot be in the future');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.notification.updateMany({
        where: {
          AND: [
            visibleNotifications(userId, now),
            { readAt: null, createdAt: { lte: throughCreatedAt } },
          ],
        },
        data: { readAt: now },
      });
      if (result.count) await this.changed(tx, userId, now);
      return { markedCount: result.count };
    });
  }
  private changed(tx: Prisma.TransactionClient, userId: string, now: Date) {
    return this.outbox.append(tx, {
      type: 'notifications.changed',
      applicationId: null,
      conversationId: null,
      userId,
      occurredAt: now,
      payload: {},
    });
  }
}
function dto(row: Notification) {
  return {
    id: row.id,
    type: row.type,
    category: notificationCategory(row.type),
    schemaVersion: 1,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    readAt: row.readAt,
    expiresAt: row.expiresAt,
    target: {
      applicationId: row.applicationId,
      listingId: row.listingId,
      workflowId: row.workflowId,
      proposalId: row.proposalId,
      appointmentId: row.appointmentId,
      section: row.section,
      activityId: row.sourceActivityId,
      action: 'OPEN_HISTORY' as const,
    },
  };
}
