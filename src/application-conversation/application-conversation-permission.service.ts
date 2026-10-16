import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ApplicationActivityService } from '../applications/application-activity.service';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ConversationSide,
} from '../generated/prisma/enums';
import { ApplicationConversationAccessService } from './application-conversation-access.service';
import { conversationCapabilities } from './application-conversation.policy';

@Injectable()
export class ApplicationConversationPermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationConversationAccessService,
    private readonly activity: ApplicationActivityService,
  ) {}
  setApplicantReplies(applicationId: string, userId: string, enabled: boolean) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.lockAndAuthorize(
        tx,
        applicationId,
        userId,
        ConversationSide.PROVIDER,
      );
      const current =
        application.conversation?.applicantRepliesEnabled ?? false;
      if (
        !conversationCapabilities(
          application,
          current,
          ConversationSide.PROVIDER,
        ).canCurrentUserManageApplicantReplies
      ) {
        throw new ConflictException(
          'The application lifecycle does not allow changing reply permission',
        );
      }
      if (current !== enabled) {
        if (application.conversation) {
          await tx.applicationConversation.update({
            where: { id: application.conversation.id },
            data: { applicantRepliesEnabled: enabled },
          });
        } else {
          const conversation = await tx.applicationConversation.create({
            data: { applicationId, applicantRepliesEnabled: enabled },
          });
          await this.activity.appendWithinTransaction(tx, {
            applicationId,
            type: ApplicationActivityType.CONVERSATION_OPENED,
            actorUserId: userId,
            actorType: ApplicationActivityActorType.PROVIDER,
            visibility: ApplicationActivityVisibility.BOTH,
            occurredAt: conversation.openedAt,
          });
        }
        await this.activity.appendWithinTransaction(tx, {
          applicationId,
          type: enabled
            ? ApplicationActivityType.APPLICANT_REPLIES_ENABLED
            : ApplicationActivityType.APPLICANT_REPLIES_DISABLED,
          actorUserId: userId,
          actorType: ApplicationActivityActorType.PROVIDER,
          visibility: ApplicationActivityVisibility.BOTH,
        });
      }
      return conversationCapabilities(
        application,
        enabled,
        ConversationSide.PROVIDER,
      );
    });
  }
}
