import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationDocumentAccessService } from './application-document-access.service';
import { ApplicationDocumentActivityService } from './application-document-activity.service';
import { ApplicationDocumentConfigService } from './application-document-config.service';
import { ApplicationDocumentStorageService } from './application-document-storage.service';
import { ApplicationDocumentFinalizationService } from './application-document-finalization.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    ApplicationDocumentAccessService,
    ApplicationDocumentActivityService,
    ApplicationDocumentConfigService,
    ApplicationDocumentStorageService,
    ApplicationDocumentFinalizationService,
  ],
  exports: [
    ApplicationDocumentAccessService,
    ApplicationDocumentActivityService,
    ApplicationDocumentConfigService,
    ApplicationDocumentStorageService,
    ApplicationDocumentFinalizationService,
  ],
})
export class ApplicationDocumentDomainModule {}
