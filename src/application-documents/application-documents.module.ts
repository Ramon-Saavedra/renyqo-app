import { ListingConsumerAccessModule } from '../listings/listing-consumer-access.module';
import { ApplicationDocumentReadModule } from './application-document-read.module';
import { VerificationCommandHttpService } from './verification-command-http.service';
import { ProviderVerificationCommandsController } from './provider-verification-commands.controller';
import { ProviderVerificationSubjectsController } from './provider-verification-subjects.controller';
import {
  ProviderVerificationRequirementsController,
  ApplicantVerificationRequirementsController,
} from './verification-requirements.controller';
import { Module } from '@nestjs/common';
import { ApplicationDocumentDomainModule } from './application-document-domain.module';
import { ApplicationDocumentRequestService } from './application-document-request.service';
import { ApplicationDocumentService } from './application-document.service';
import { ApplicationDocumentUploadGuard } from './application-document-upload.guard';
import { ApplicationDocumentUploadPipe } from './application-document-upload.pipe';
import { ProviderDocumentsController } from './provider-documents.controller';
import { ApplicantDocumentsController } from './applicant-documents.controller';

@Module({
  imports: [
    ListingConsumerAccessModule,
    ApplicationDocumentDomainModule,
    ApplicationDocumentReadModule,
  ],
  controllers: [
    ProviderDocumentsController,
    ApplicantDocumentsController,
    ProviderVerificationCommandsController,
    ProviderVerificationSubjectsController,
    ProviderVerificationRequirementsController,
    ApplicantVerificationRequirementsController,
  ],
  providers: [
    VerificationCommandHttpService,
    ApplicationDocumentRequestService,
    ApplicationDocumentService,
    ApplicationDocumentUploadGuard,
    ApplicationDocumentUploadPipe,
  ],
})
export class ApplicationDocumentsModule {}
