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
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
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
@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
export class ProviderDocumentsController {
  constructor(
    private readonly requests: ApplicationDocumentRequestService,
    private readonly documents: ApplicationDocumentService,
  ) {}

  @Get('document-requests')
  list(
    @Param() params: DocumentApplicationParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.requests.list(params.applicationId, user.id, 'provider');
  }

  @Post('document-requests')
  create(
    @Param() params: DocumentApplicationParamsDto,
    @Body() dto: CreateDocumentRequestsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.requests.create(params.applicationId, user.id, dto.requests);
  }

  @Post('document-requests/:requestId/replacements')
  replace(
    @Param() params: DocumentRequestParamsDto,
    @Body() _dto: UploadDocumentBodyDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.requests.replace(
      params.applicationId,
      params.requestId,
      user.id,
    );
  }

  @Patch('document-requests/:requestId/cancel')
  cancel(
    @Param() params: DocumentRequestParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.requests.cancel(
      params.applicationId,
      params.requestId,
      user.id,
    );
  }

  @Get('documents/:documentId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  download(
    @Param() params: DocumentFileParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.documents.download(
      params.applicationId,
      params.documentId,
      user.id,
      'provider',
    );
  }

  @Post('documents/:documentId/review')
  review(
    @Param() params: DocumentFileParamsDto,
    @Body() _dto: ReviewDocumentDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.documents.review(
      params.applicationId,
      params.documentId,
      user.id,
    );
  }
}
