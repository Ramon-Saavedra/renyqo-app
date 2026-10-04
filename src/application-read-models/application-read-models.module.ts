import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationConversationReadModule } from '../application-conversation/application-conversation-read.module';
import { ApplicationAttentionModule } from '../application-attention/application-attention.module';
import { ApplicationDocumentReadModule } from '../application-documents/application-document-read.module';
import { ApplicationViewingReadModule } from '../application-viewings/application-viewing-read.module';
import { ApplicationProcessReadModule } from '../applications/application-process-read.module';
import { ProviderReadModelsController } from './provider-read-models.controller';
import { ApplicantReadModelsController } from './applicant-read-models.controller';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ProviderApplicationOverviewQueryService } from './provider-application-overview-query.service';
import { ApplicantApplicationOverviewQueryService } from './applicant-application-overview-query.service';
import { ApplicationHistoryQueryService } from './application-history-query.service';

@Module({
  imports: [
    PrismaModule,
    ApplicationConversationReadModule,
    ApplicationAttentionModule,
    ApplicationDocumentReadModule,
    ApplicationViewingReadModule,
    ApplicationProcessReadModule,
  ],
  controllers: [ProviderReadModelsController, ApplicantReadModelsController],
  providers: [
    ApplicationWorkspaceQueryService,
    ProviderApplicationOverviewQueryService,
    ApplicantApplicationOverviewQueryService,
    ApplicationHistoryQueryService,
  ],
})
export class ApplicationReadModelsModule {}
