import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import { ApplicantListingsQueryDto } from './dto/applicant-listings-query.dto';
import { ListingsService } from './listings.service';

@Controller('listings')
export class ApplicantListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Get()
  async findAll(
    @Query() query: ApplicantListingsQueryDto,
  ): Promise<ApplicantListingsPageDto> {
    return this.listingsService.findPublishedForApplicant(query);
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ApplicantListingDetailDto> {
    return this.listingsService.findPublishedDetailForApplicant(id);
  }
}
