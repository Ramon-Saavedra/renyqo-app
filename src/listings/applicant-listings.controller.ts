import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Role } from '../generated/prisma/enums';
import { CurrentUserOptional } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import { ApplicantListingsQueryDto } from './dto/applicant-listings-query.dto';
import { ApplicantListingsService } from './applicant-listings.service';

@Controller('listings')
export class ApplicantListingsController {
  constructor(
    private readonly applicantListingsService: ApplicantListingsService,
  ) {}

  @Get()
  async findAll(
    @Query() query: ApplicantListingsQueryDto,
    @CurrentUserOptional() user: SafeUser | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApplicantListingsPageDto> {
    if (query.onlyMatching) {
      if (!user) {
        throw new BadRequestException(
          'onlyMatching requires an active applicant session',
        );
      }

      if (user.role !== Role.APPLICANT) {
        throw new ForbiddenException();
      }

      if (
        !(await this.applicantListingsService.isProfileCompleteForUser(user.id))
      ) {
        throw new BadRequestException(
          'A complete applicant profile is required for onlyMatching',
        );
      }
    }

    return this.applicantListingsService.findPublishedForApplicant(
      query,
      user,
      res,
    );
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUserOptional() user: SafeUser | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApplicantListingDetailDto> {
    return this.applicantListingsService.findPublishedDetailForApplicant(
      id,
      user,
      res,
    );
  }
}
