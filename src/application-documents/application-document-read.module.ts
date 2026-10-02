import { Module } from '@nestjs/common';
import { ApplicationDocumentReadService } from './application-document-read.service';

@Module({
  providers: [ApplicationDocumentReadService],
  exports: [ApplicationDocumentReadService],
})
export class ApplicationDocumentReadModule {}
