import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import { incomingUnreadMessages } from './application-conversation.policy';

export type ConversationAttentionFacts = {
  lastSender: ConversationSide | null;
  lastMessageAt: Date | null;
  historicalUnreadMessageCount: number;
};

@Injectable()
export class ApplicationConversationReadService {
  async batch(
    tx: Prisma.TransactionClient,
    applicationIds: readonly string[],
    side: ConversationSide,
  ): Promise<Map<string, ConversationAttentionFacts>> {
    const result = new Map<string, ConversationAttentionFacts>();
    if (!applicationIds.length) return result;
    const conversations = await tx.applicationConversation.findMany({
      where: { applicationId: { in: [...applicationIds] } },
      select: { id: true, applicationId: true },
    });
    if (!conversations.length) return result;
    const ids = conversations.map((row) => row.id);
    const unread = await tx.applicationMessage.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: ids }, ...incomingUnreadMessages(side) },
      _count: { _all: true },
    });
    const latest = await tx.$queryRaw<
      { conversationId: string; senderType: string; createdAt: Date }[]
    >`
      SELECT DISTINCT ON (conversation_id)
        conversation_id AS "conversationId", sender_type AS "senderType", created_at AS "createdAt"
      FROM application_messages
      WHERE conversation_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY conversation_id, sequence DESC
    `;
    const counts = new Map(
      unread.map((row) => [row.conversationId, row._count._all]),
    );
    const messages = new Map(latest.map((row) => [row.conversationId, row]));
    for (const conversation of conversations) {
      const message = messages.get(conversation.id);
      result.set(conversation.applicationId, {
        lastSender: message
          ? message.senderType === 'provider'
            ? ConversationSide.PROVIDER
            : ConversationSide.APPLICANT
          : null,
        lastMessageAt: message?.createdAt ?? null,
        historicalUnreadMessageCount: counts.get(conversation.id) ?? 0,
      });
    }
    return result;
  }
}
