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
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import { VerificationCommandDto } from './dto/verification-input.dto';
import { VerificationCommandHttpService } from './verification-command-http.service';

@Controller('provider/applications/:applicationId/verification-commands')
@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
export class ProviderVerificationCommandsController {
  constructor(private readonly commands: VerificationCommandHttpService) {}

  @Post()
  @HttpCode(200)
  execute(
    @Param() params: DocumentApplicationParamsDto,
    @CurrentUser() user: SafeUser,
    @Body() dto: VerificationCommandDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.commands.execute(params.applicationId, user.id, dto, key);
  }
}
