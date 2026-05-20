import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { Application } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('listings')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post(':id/apply')
  @HttpCode(HttpStatus.CREATED)
  apply(
    @Param('id') listingId: string,
    @Req() req: Request,
  ): Promise<Application> {
    const user = req.user as SafeUser;
    return this.applicationsService.apply(listingId, user.id);
  }
}
