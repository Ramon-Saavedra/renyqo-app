import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { EligibilityResponseDto } from './dto/eligibility-response.dto';
import { EligibilityService } from './eligibility.service';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('listings')
export class EligibilityController {
  constructor(private readonly eligibilityService: EligibilityService) {}

  @Get(':id/eligibility')
  check(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<EligibilityResponseDto> {
    return this.eligibilityService.check(listingId, user.id);
  }
}
