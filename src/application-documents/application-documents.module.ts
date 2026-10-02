import { Module } from '@nestjs/common';
import { ApplicationDocumentDomainModule } from './application-document-domain.module';
import { ApplicationDocumentRequestService } from './application-document-request.service';
import { ApplicationDocumentService } from './application-document.service';
import { ApplicationDocumentUploadGuard } from './application-document-upload.guard';
import { ApplicationDocumentUploadPipe } from './application-document-upload.pipe';
import { ProviderDocumentsController } from './provider-documents.controller';
import { ApplicantDocumentsController } from './applicant-documents.controller';

@Module({
  imports: [ApplicationDocumentDomainModule],
  controllers: [ProviderDocumentsController, ApplicantDocumentsController],
  providers: [
    ApplicationDocumentRequestService,
    ApplicationDocumentService,
    ApplicationDocumentUploadGuard,
    ApplicationDocumentUploadPipe,
  ],
})
export class ApplicationDocumentsModule {}
