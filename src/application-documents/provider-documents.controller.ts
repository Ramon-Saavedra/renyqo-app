import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicationDocumentRequestService } from './application-document-request.service';
import { ApplicationDocumentService } from './application-document.service';
import {
  CreateDocumentRequestsDto,
  DocumentApplicationParamsDto,
  DocumentFileParamsDto,
  DocumentRequestParamsDto,
  ReviewDocumentDto,
  UploadDocumentBodyDto,
} from './dto/document-input.dto';

@Controller('provider/applications/:applicationId')
@UseGuards(AuthenticatedGuard)
export class ProviderDocumentsController {
  constructor(
    private readonly requests: ApplicationDocumentRequestService,
    private readonly documents: ApplicationDocumentService,
  ) {}

  @Get('document-requests')
  list(@Param() params: DocumentApplicationParamsDto, @Req() request: Request) {
    return this.requests.list(
      params.applicationId,
      providerActorFromRequest(request),
      'provider',
    );
  }

  @Post('document-requests')
  create(
    @Param() params: DocumentApplicationParamsDto,
    @Body() dto: CreateDocumentRequestsDto,
    @Req() request: Request,
  ) {
    return this.requests.create(
      params.applicationId,
      providerActorFromRequest(request),
      dto.requests,
    );
  }

  @Post('document-requests/:requestId/replacements')
  replace(
    @Param() params: DocumentRequestParamsDto,
    @Body() _dto: UploadDocumentBodyDto,
    @Req() request: Request,
  ) {
    return this.requests.replace(
      params.applicationId,
      params.requestId,
      providerActorFromRequest(request),
    );
  }

  @Patch('document-requests/:requestId/cancel')
  cancel(@Param() params: DocumentRequestParamsDto, @Req() request: Request) {
    return this.requests.cancel(
      params.applicationId,
      params.requestId,
      providerActorFromRequest(request),
    );
  }

  @Get('documents/:documentId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  download(@Param() params: DocumentFileParamsDto, @Req() request: Request) {
    return this.documents.download(
      params.applicationId,
      params.documentId,
      providerActorFromRequest(request),
      'provider',
    );
  }

  @Post('documents/:documentId/review')
  review(
    @Param() params: DocumentFileParamsDto,
    @Body() _dto: ReviewDocumentDto,
    @Req() request: Request,
  ) {
    return this.documents.review(
      params.applicationId,
      params.documentId,
      providerActorFromRequest(request),
    );
  }
}
