import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ReadModelPageQueryDto } from '../application-read-models/dto/read-model-input.dto';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import {
  HouseholdSubjectDto,
  VerificationSubjectParamsDto,
} from './dto/verification-input.dto';
import { VerificationSubjectService } from './verification-subject.service';
import { VerificationQueryService } from './verification-query.service';

@Controller('provider/applications/:applicationId/verification-subjects')
@UseGuards(AuthenticatedGuard)
export class ProviderVerificationSubjectsController {
  constructor(
    private readonly subjects: VerificationSubjectService,
    private readonly queries: VerificationQueryService,
  ) {}

  @Get()
  list(
    @Param() params: DocumentApplicationParamsDto,
    @Req() request: Request,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.queries.subjects(
      params.applicationId,
      providerActorFromRequest(request),
      query,
    );
  }

  @Put('household-members/:subjectKey')
  async create(
    @Param() params: VerificationSubjectParamsDto,
    @Req() request: Request,
    @Body() dto: HouseholdSubjectDto,
  ) {
    const subject = await this.subjects.householdMember(
      params.applicationId,
      providerActorFromRequest(request),
      params.subjectKey,
      dto.displayLabel,
    );
    return {
      id: subject.id,
      kind: subject.kind,
      subjectKey: subject.subjectKey,
      displayLabel: subject.displayLabel,
      createdAt: subject.createdAt,
      provenance: subject.provenance,
    };
  }
}
