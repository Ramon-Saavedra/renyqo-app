import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../guards/authenticated.guard';
import { sessionAuthorityFromRequest } from '../../provider-authorization/domain/authority-reference';
import { SecurityLinkTrafficGuard } from '../../security/security-link-traffic.guard';
import { EmailVerificationService } from './email-verification.service';
export class EmailVerificationDto {
  @IsString() @Length(43, 43) token!: string;
}
@Controller('auth/email-verification')
@UseGuards(AuthenticatedGuard, SecurityLinkTrafficGuard)
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}
  @Post('request')
  @HttpCode(200)
  request(@Req() req: Request) {
    return this.verification.request(sessionAuthorityFromRequest(req));
  }
  @Post('confirm')
  @HttpCode(200)
  confirm(@Req() req: Request, @Body() dto: EmailVerificationDto) {
    return this.verification.confirm(
      sessionAuthorityFromRequest(req),
      dto.token,
    );
  }
}
