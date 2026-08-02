import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { WaitingCountResponseDto } from './dto/waiting-count-response.dto';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider')
export class ProviderApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get('applications')
  async findAll(
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findAllByProvider(
      user.id,
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }

  @Get('listings/:id/applications')
  async findByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findAllByListing(
      listingId,
      user.id,
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }

  @Get('listings/:id/active-applications')
  async findActiveByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findActiveByListing(
      listingId,
      user.id,
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }

  @Get('listings/:id/waiting-count')
  async findWaitingCount(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<WaitingCountResponseDto> {
    const waitingCount =
      await this.applicationsService.findWaitingCountByListing(
        listingId,
        user.id,
      );
    return new WaitingCountResponseDto(waitingCount);
  }

  @Patch('applications/:id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applicationsService.reject(
      applicationId,
      user.id,
    );
    return new ApplicationResponseDto(application);
  }
}
