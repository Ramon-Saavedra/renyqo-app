import type { Request } from 'express';
import { Req } from '@nestjs/common';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { ApplicationDocumentRequestService } from './application-document-request.service';
import { ApplicationDocumentService } from './application-document.service';
import {
  DocumentApplicationParamsDto,
  DocumentFileParamsDto,
  DocumentRequestParamsDto,
  UploadDocumentBodyDto,
} from './dto/document-input.dto';
import { ApplicationDocumentUploadGuard } from './application-document-upload.guard';
import {
  ApplicationDocumentUploadPipe,
  documentUploadOptions,
} from './application-document-upload.pipe';

@Controller('applicant/applications/:applicationId')
@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
export class ApplicantDocumentsController {
  constructor(
    private readonly requests: ApplicationDocumentRequestService,
    private readonly documents: ApplicationDocumentService,
  ) {}

  @Get('document-requests')
  list(@Param() params: DocumentApplicationParamsDto, @Req() request: Request) {
    return this.requests.list(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
    );
  }

  @Post('document-requests/:requestId/document')
  @UseGuards(ApplicationDocumentUploadGuard)
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  upload(
    @Param() params: DocumentRequestParamsDto,
    @Body() _dto: UploadDocumentBodyDto,
    @UploadedFile(ApplicationDocumentUploadPipe) file: Express.Multer.File,
    @Req() request: Request,
  ) {
    return this.documents.upload(
      params.applicationId,
      params.requestId,
      sessionAuthorityFromRequest(request),
      file,
    );
  }

  @Get('documents/:documentId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  download(@Param() params: DocumentFileParamsDto, @Req() request: Request) {
    return this.documents.download(
      params.applicationId,
      params.documentId,
      sessionAuthorityFromRequest(request),
      'applicant',
    );
  }
}
