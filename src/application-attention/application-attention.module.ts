import { Module } from '@nestjs/common';
import { ListingConsumerAccessModule } from '../listings/listing-consumer-access.module';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationConversationReadModule } from '../application-conversation/application-conversation-read.module';
import { ApplicationDocumentReadModule } from '../application-documents/application-document-read.module';
import { ApplicationViewingReadModule } from '../application-viewings/application-viewing-read.module';
import { ApplicationPendingActionService } from './application-pending-action.service';
import { ApplicationAttentionQueryService } from './application-attention-query.service';
import { ApplicantListingAttentionEnricher } from './applicant-listing-attention.enricher';
import { ProviderActiveApplicationAttentionEnricher } from './provider-active-application-attention.enricher';
import { ProviderAttentionController } from './provider-attention.controller';
import { ApplicantAttentionController } from './applicant-attention.controller';

@Module({
  imports: [
    ListingConsumerAccessModule,
    ProviderAuthorizationModule,
    PrismaModule,
    ApplicationConversationReadModule,
    ApplicationDocumentReadModule,
    ApplicationViewingReadModule,
  ],
  controllers: [ProviderAttentionController, ApplicantAttentionController],
  providers: [
    ApplicationPendingActionService,
    ApplicationAttentionQueryService,
    ApplicantListingAttentionEnricher,
    ProviderActiveApplicationAttentionEnricher,
  ],
  exports: [
    ApplicationAttentionQueryService,
    ApplicantListingAttentionEnricher,
    ProviderActiveApplicationAttentionEnricher,
  ],
})
export class ApplicationAttentionModule {}
