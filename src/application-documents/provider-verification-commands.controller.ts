import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import { VerificationCommandDto } from './dto/verification-input.dto';
import { VerificationCommandHttpService } from './verification-command-http.service';

@Controller('provider/applications/:applicationId/verification-commands')
@UseGuards(AuthenticatedGuard)
export class ProviderVerificationCommandsController {
  constructor(private readonly commands: VerificationCommandHttpService) {}

  @Post()
  @HttpCode(200)
  execute(
    @Param() params: DocumentApplicationParamsDto,
    @Req() request: Request,
    @Body() dto: VerificationCommandDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.commands.execute(
      params.applicationId,
      providerActorFromRequest(request),
      dto,
      key,
    );
  }
}
