import { ListingConsumerAccessModule } from '../listings/listing-consumer-access.module';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { ApplicationConversationAccessService } from './application-conversation-access.service';
import { ApplicationConversationPermissionService } from './application-conversation-permission.service';
import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationConversationService } from './application-conversation.service';
import { ApplicationMessageService } from './application-message.service';
import { ApplicantConversationController } from './applicant-conversation.controller';
import { ProviderConversationController } from './provider-conversation.controller';

@Module({
  imports: [
    ProviderAuthorizationModule,
    ListingConsumerAccessModule,
    PrismaModule,
    ApplicationsModule,
    OutboxModule,
  ],
  controllers: [
    ProviderConversationController,
    ApplicantConversationController,
  ],
  providers: [
    ApplicationConversationService,
    ApplicationMessageService,
    ApplicationConversationAccessService,
    ApplicationConversationPermissionService,
  ],
})
export class ApplicationConversationModule {}
