import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { ListingConsumerAccessModule } from '../listings/listing-consumer-access.module';
import { ApplicationDocumentDomainModule } from './application-document-domain.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VerificationQueryService } from './verification-query.service';
import { Module } from '@nestjs/common';
import { ApplicationDocumentReadService } from './application-document-read.service';

@Module({
  imports: [
    ProviderAuthorizationModule,
    ListingConsumerAccessModule,
    PrismaModule,
    ApplicationDocumentDomainModule,
  ],
  providers: [ApplicationDocumentReadService, VerificationQueryService],
  exports: [ApplicationDocumentReadService, VerificationQueryService],
})
export class ApplicationDocumentReadModule {}
