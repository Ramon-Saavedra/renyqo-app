import { BadRequestException, Injectable } from '@nestjs/common';
import type { ApplicationMessage, Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import { ApplicationMessageResponseDto } from './dto/conversation-response.dto';
import { ConversationQueryDto } from './dto/conversation-query.dto';
import { MAX_MESSAGE_LENGTH, PLAIN_TEXT_MESSAGE } from './dto/send-message.dto';
import { incomingUnreadMessages } from './application-conversation.policy';

@Injectable()
export class ApplicationMessageService {
  validateBody(body: string): string {
    if (typeof body !== 'string') {
      throw new BadRequestException('Message body must be text');
    }
    const trimmed = body.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_MESSAGE_LENGTH ||
      !PLAIN_TEXT_MESSAGE.test(trimmed)
    ) {
      throw new BadRequestException(
        'Message must contain 1–4000 characters of plain text',
      );
    }
    return trimmed;
  }

  async snapshot(
    tx: Prisma.TransactionClient,
    conversationId: string,
    side: ConversationSide,
  ): Promise<{ lastMessage: ApplicationMessage | null; unreadCount: number }> {
    const conversation = await tx.applicationConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        messages: { orderBy: { sequence: 'desc' }, take: 1 },
        _count: {
          select: {
            messages: { where: incomingUnreadMessages(side) },
          },
        },
      },
    });
    return {
      lastMessage: conversation.messages[0] ?? null,
      unreadCount: conversation._count.messages,
    };
  }

  async readPage(
    tx: Prisma.TransactionClient,
    conversationId: string,
    query: ConversationQueryDto,
  ): Promise<{ messages: ApplicationMessageResponseDto[]; hasMore: boolean }> {
    const rows = await tx.applicationMessage.findMany({
      where: { conversationId, sequence: { gt: query.afterSequence } },
      orderBy: { sequence: 'asc' },
      take: query.limit + 1,
    });
    return {
      messages: rows.slice(0, query.limit).map((row) => this.toDto(row)),
      hasMore: rows.length > query.limit,
    };
  }

  appendWithinTransaction(
    tx: Prisma.TransactionClient,
    conversationId: string,
    side: ConversationSide,
    sequence: number,
    body: string,
  ): Promise<ApplicationMessage> {
    return tx.applicationMessage.create({
      data: {
        conversationId,
        senderType: side,
        sequence,
        body: this.validateBody(body),
      },
    });
  }

  async markReadWithinTransaction(
    tx: Prisma.TransactionClient,
    conversationId: string,
    side: ConversationSide,
    throughSequence: number,
  ): Promise<number> {
    const result = await tx.applicationMessage.updateMany({
      where: {
        conversationId,
        ...incomingUnreadMessages(side),
        sequence: { lte: throughSequence },
      },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  toDto(message: ApplicationMessage): ApplicationMessageResponseDto {
    return new ApplicationMessageResponseDto(message);
  }
}
