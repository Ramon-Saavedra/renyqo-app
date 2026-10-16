import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import {
  conversationCapabilities,
  incomingUnreadMessages,
} from './application-conversation.policy';
import type { ApplicationProcessState } from '../applications/application-process.policy';
import { CompactConversationSummaryDto } from './dto/compact-conversation-summary.dto';
export type ConversationAttentionFacts = {
  hasMessages: boolean;
  applicantRepliesEnabled: boolean;
  historicalUnreadMessageCount: number;
};
export const emptyConversationFacts: ConversationAttentionFacts = {
  hasMessages: false,
  applicantRepliesEnabled: false,
  historicalUnreadMessageCount: 0,
};
@Injectable()
export class ApplicationConversationReadService {
  summary(
    application: ApplicationProcessState,
    facts: ConversationAttentionFacts,
    side: ConversationSide,
  ) {
    return new CompactConversationSummaryDto(
      facts.hasMessages,
      conversationCapabilities(
        application,
        facts.applicantRepliesEnabled,
        side,
      ),
    );
  }
  async batch(
    tx: Prisma.TransactionClient,
    applicationIds: readonly string[],
    side: ConversationSide,
  ): Promise<Map<string, ConversationAttentionFacts>> {
    if (!applicationIds.length) return new Map();
    const rows = await tx.applicationConversation.findMany({
      where: { applicationId: { in: [...applicationIds] } },
      select: {
        applicationId: true,
        applicantRepliesEnabled: true,
        messages: { select: { id: true }, take: 1 },
        _count: {
          select: { messages: { where: incomingUnreadMessages(side) } },
        },
      },
    });
    return new Map(
      rows.map((row) => [
        row.applicationId,
        {
          hasMessages: row.messages.length > 0,
          applicantRepliesEnabled: row.applicantRepliesEnabled,
          historicalUnreadMessageCount: row._count.messages,
        },
      ]),
    );
  }
}
