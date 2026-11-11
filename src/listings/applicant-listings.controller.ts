import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  Req,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
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
    @Req() request: Request,
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
    }

    return this.applicantListingsService.findPublishedForApplicant(
      query,
      user,
      res,
      user ? sessionAuthorityFromRequest(request) : undefined,
    );
  }

  @Get(':id')
  async findOne(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUserOptional() user: SafeUser | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApplicantListingDetailDto> {
    return this.applicantListingsService.findPublishedDetailForApplicant(
      id,
      user,
      res,
      user ? sessionAuthorityFromRequest(request) : undefined,
    );
  }
}
