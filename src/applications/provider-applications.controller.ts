import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderActiveApplicationAttentionEnricher } from '../application-attention/provider-active-application-attention.enricher';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { ProviderActiveApplicationResponseDto } from './dto/provider-active-application-response.dto';
import { ProviderExitedApplicationsResponseDto } from './dto/provider-exited-application-response.dto';
import { WaitingCountResponseDto } from './dto/waiting-count-response.dto';

@UseGuards(AuthenticatedGuard)
@Controller('provider')
export class ProviderApplicationsController {
  constructor(
    private readonly applicationsService: ApplicationsService,
    private readonly activeAttention: ProviderActiveApplicationAttentionEnricher,
  ) {}

  @Get('applications')
  async findAll(@Req() request: Request): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findAllByProvider(
      providerActorFromRequest(request),
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }

  @Get('listings/:id/applications')
  async findByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findAllByListing(
      listingId,
      providerActorFromRequest(request),
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }

  @Get('listings/:id/active-applications')
  async findActiveByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<ProviderActiveApplicationResponseDto[]> {
    const applications = await this.applicationsService.findActiveByListing(
      listingId,
      providerActorFromRequest(request),
    );
    const attention = await this.activeAttention.forApplications(
      providerActorFromRequest(request),
      applications.map((application) => application.id),
    );
    return applications.map((application) => {
      const summary = attention.get(application.id);
      if (!summary) throw new NotFoundException('Application not found');
      return new ProviderActiveApplicationResponseDto(application, summary);
    });
  }

  @Get('listings/:id/exited-applications')
  async findExitedByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<ProviderExitedApplicationsResponseDto> {
    const result = await this.applicationsService.findExitedByListing(
      listingId,
      providerActorFromRequest(request),
    );
    return new ProviderExitedApplicationsResponseDto(result);
  }

  @Get('listings/:id/waiting-count')
  async findWaitingCount(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<WaitingCountResponseDto> {
    const waitingCount =
      await this.applicationsService.findWaitingCountByListing(
        listingId,
        providerActorFromRequest(request),
      );
    return new WaitingCountResponseDto(waitingCount);
  }

  @Patch('applications/:id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Req() request: Request,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applicationsService.reject(
      applicationId,
      providerActorFromRequest(request),
    );
    return new ApplicationResponseDto(application);
  }

  @Patch('applications/:id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('id', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Req() request: Request,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applicationsService.restore(
      applicationId,
      providerActorFromRequest(request),
    );
    return new ApplicationResponseDto(application);
  }
}
