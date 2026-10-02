import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationConversationService } from './application-conversation.service';
import { ApplicationMessageService } from './application-message.service';
import { ApplicantConversationController } from './applicant-conversation.controller';
import { ProviderConversationController } from './provider-conversation.controller';

@Module({
  imports: [PrismaModule, ApplicationsModule],
  controllers: [
    ProviderConversationController,
    ApplicantConversationController,
  ],
  providers: [ApplicationConversationService, ApplicationMessageService],
})
export class ApplicationConversationModule {}
