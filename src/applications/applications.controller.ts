import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto } from './dto/application-response.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('listings')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post(':id/apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applicationsService.apply(
      listingId,
      user.id,
    );
    return new ApplicationResponseDto(application);
  }
}
