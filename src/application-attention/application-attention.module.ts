import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationConversationReadModule } from '../application-conversation/application-conversation-read.module';
import { ApplicationDocumentReadModule } from '../application-documents/application-document-read.module';
import { ApplicationViewingReadModule } from '../application-viewings/application-viewing-read.module';
import { ApplicationPendingActionService } from './application-pending-action.service';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import { ProviderAttentionController } from './provider-attention.controller';
import { ApplicantAttentionController } from './applicant-attention.controller';

@Module({
  imports: [
    PrismaModule,
    ApplicationConversationReadModule,
    ApplicationDocumentReadModule,
    ApplicationViewingReadModule,
  ],
  controllers: [ProviderAttentionController, ApplicantAttentionController],
  providers: [
    ApplicationPendingActionService,
    ApplicationAttentionQueryService,
  ],
  exports: [ApplicationAttentionQueryService],
})
export class ApplicationAttentionModule {}
