import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ConversationSide,
} from '../generated/prisma/enums';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ConversationOutboxProducer } from '../outbox/conversation-outbox.producer';
import { ApplicationMessageService } from './application-message.service';
import { conversationCapabilities } from './application-conversation.policy';
import {
  ApplicationConversationAccessService,
  type ConversationApplication,
} from './application-conversation-access.service';
import { ConversationQueryDto } from './dto/conversation-query.dto';
import {
  ApplicationMessageResponseDto,
  ConversationDetailResponseDto,
  ConversationSummaryResponseDto,
  MarkConversationReadResponseDto,
} from './dto/conversation-response.dto';

@Injectable()
export class ApplicationConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: ApplicationMessageService,
    private readonly activity: ApplicationActivityService,
    private readonly access: ApplicationConversationAccessService,
    private readonly outbox: ConversationOutboxProducer,
  ) {}

  summary(
    applicationId: string,
    userId: string,
    side: ConversationSide,
  ): Promise<ConversationSummaryResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          side,
        );
        return this.toSummary(tx, application, side);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  detail(
    applicationId: string,
    userId: string,
    side: ConversationSide,
    query: ConversationQueryDto,
  ): Promise<ConversationDetailResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          side,
        );
        const summary = await this.toSummary(tx, application, side);
        const page = application.conversation
          ? await this.messages.readPage(tx, application.conversation.id, query)
          : { messages: [], hasMore: false };
        return new ConversationDetailResponseDto(
          summary,
          page.messages,
          page.hasMore,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  send(
    applicationId: string,
    userId: string,
    side: ConversationSide,
    body: string,
  ): Promise<ApplicationMessageResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.lockAndAuthorize(
        tx,
        applicationId,
        userId,
        side,
      );
      const summary = await this.toSummary(tx, application, side);
      if (!summary.canCurrentUserSend) {
        throw new ConflictException(
          'The conversation does not allow this side to send now',
        );
      }
      const validatedBody = this.messages.validateBody(body);
      let conversationId = application.conversation?.id;
      if (!conversationId) {
        const conversation = await tx.applicationConversation.create({
          data: { applicationId },
        });
        conversationId = conversation.id;
        await this.activity.appendWithinTransaction(tx, {
          applicationId,
          type: ApplicationActivityType.CONVERSATION_OPENED,
          actorUserId: userId,
          actorType: ApplicationActivityActorType.PROVIDER,
          visibility: ApplicationActivityVisibility.BOTH,
          occurredAt: conversation.openedAt,
        });
      }
      const message = await this.messages.appendWithinTransaction(
        tx,
        conversationId,
        side,
        (summary.lastMessage?.sequence ?? 0) + 1,
        validatedBody,
      );
      await this.activity.appendWithinTransaction(tx, {
        applicationId,
        type: ApplicationActivityType.MESSAGE_SENT,
        actorUserId: userId,
        actorType:
          side === ConversationSide.PROVIDER
            ? ApplicationActivityActorType.PROVIDER
            : ApplicationActivityActorType.APPLICANT,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: message.createdAt,
      });
      await this.outbox.messageCreated(tx, {
        applicationId,
        conversationId,
        occurredAt: message.createdAt,
        messageId: message.id,
        messageSequence: message.sequence,
      });
      return this.messages.toDto(message);
    });
  }

  markRead(
    applicationId: string,
    userId: string,
    side: ConversationSide,
    throughSequence: number,
  ): Promise<MarkConversationReadResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.lockAndAuthorize(
        tx,
        applicationId,
        userId,
        side,
      );
      if (!application.conversation) {
        return new MarkConversationReadResponseDto(0);
      }
      const snapshot = await this.messages.snapshot(
        tx,
        application.conversation.id,
        side,
      );
      if (throughSequence > (snapshot.lastMessage?.sequence ?? 0)) {
        throw new BadRequestException(
          'throughSequence exceeds the last message',
        );
      }
      const count = await this.messages.markReadWithinTransaction(
        tx,
        application.conversation.id,
        side,
        throughSequence,
      );
      if (count > 0) {
        await this.outbox.readAdvanced(tx, {
          applicationId,
          conversationId: application.conversation.id,
          occurredAt: new Date(),
          readerSide: side,
          throughSequence,
          markedCount: count,
        });
      }
      return new MarkConversationReadResponseDto(count);
    });
  }

  private async toSummary(
    tx: Prisma.TransactionClient,
    application: ConversationApplication,
    side: ConversationSide,
  ): Promise<ConversationSummaryResponseDto> {
    const snapshot = application.conversation
      ? await this.messages.snapshot(tx, application.conversation.id, side)
      : { lastMessage: null, unreadCount: 0 };
    const capabilities = conversationCapabilities(
      application,
      application.conversation?.applicantRepliesEnabled ?? false,
      side,
    );
    return new ConversationSummaryResponseDto(
      application.id,
      application.conversation?.id ?? null,
      application.conversation?.openedAt ?? null,
      snapshot.lastMessage !== null,
      capabilities,
      snapshot.unreadCount,
      snapshot.lastMessage ? this.messages.toDto(snapshot.lastMessage) : null,
    );
  }
}
