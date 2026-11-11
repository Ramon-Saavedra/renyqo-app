import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProviderListingAccess,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import { ApplicationActivityService } from '../applications/application-activity.service';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ConversationSide,
} from '../generated/prisma/enums';
import { ConversationOutboxProducer } from '../outbox/conversation-outbox.producer';
import { ApplicationConversationAccessService } from './application-conversation-access.service';
import { conversationCapabilities } from './application-conversation.policy';

@Injectable()
export class ApplicationConversationPermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationConversationAccessService,
    private readonly activity: ApplicationActivityService,
    private readonly outbox: ConversationOutboxProducer,
    private readonly listings: ProviderListingAccess,
  ) {}
  setApplicantReplies(
    applicationId: string,
    actor: ProviderActor,
    enabled: boolean,
  ) {
    return this.listings.mutateApplication(
      actor,
      'conversation.manage-replies',
      applicationId,
      async (tx) => {
        const userId = actor.authority.userId;
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
          const occurredAt = new Date();
          let conversationId = application.conversation?.id;
          if (application.conversation) {
            await tx.applicationConversation.update({
              where: { id: application.conversation.id },
              data: { applicantRepliesEnabled: enabled },
            });
          } else {
            const conversation = await tx.applicationConversation.create({
              data: { applicationId, applicantRepliesEnabled: enabled },
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
          await this.activity.appendWithinTransaction(tx, {
            applicationId,
            type: enabled
              ? ApplicationActivityType.APPLICANT_REPLIES_ENABLED
              : ApplicationActivityType.APPLICANT_REPLIES_DISABLED,
            actorUserId: userId,
            actorType: ApplicationActivityActorType.PROVIDER,
            visibility: ApplicationActivityVisibility.BOTH,
          });
          if (conversationId) {
            await this.outbox.replyPermissionChanged(tx, {
              applicationId,
              conversationId,
              occurredAt,
              enabled,
            });
          }
        }
        return conversationCapabilities(
          application,
          enabled,
          ConversationSide.PROVIDER,
        );
      },
    );
  }
}
