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
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { ReadModelPageQueryDto } from '../application-read-models/dto/read-model-input.dto';
import { DocumentApplicationParamsDto } from './dto/document-input.dto';
import {
  HouseholdSubjectDto,
  VerificationSubjectParamsDto,
} from './dto/verification-input.dto';
import { VerificationSubjectService } from './verification-subject.service';
import { VerificationQueryService } from './verification-query.service';

@Controller('provider/applications/:applicationId/verification-subjects')
@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
export class ProviderVerificationSubjectsController {
  constructor(
    private readonly subjects: VerificationSubjectService,
    private readonly queries: VerificationQueryService,
  ) {}

  @Get()
  list(
    @Param() params: DocumentApplicationParamsDto,
    @CurrentUser() user: SafeUser,
    @Query() query: ReadModelPageQueryDto,
  ) {
    return this.queries.subjects(params.applicationId, user.id, query);
  }

  @Put('household-members/:subjectKey')
  async create(
    @Param() params: VerificationSubjectParamsDto,
    @CurrentUser() user: SafeUser,
    @Body() dto: HouseholdSubjectDto,
  ) {
    const subject = await this.subjects.householdMember(
      params.applicationId,
      user.id,
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
