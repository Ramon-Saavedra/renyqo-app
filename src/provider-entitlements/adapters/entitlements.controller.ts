import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsUUID, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../../auth/guards/authenticated.guard';
import { providerActorFromRequest } from '../../provider-authorization/provider-listing-access';
import { WorkspaceCapacityQuery } from '../projections/workspace-capacity.query';
import { MockPlanActivation } from './mock-plan-activation';
export class MockActivationDto {
  @IsUUID('4') planVersionId!: string;
  @IsUUID('4') commandId!: string;
  @IsInt() @Min(1) expectedRevision!: number;
  @IsInt() @Min(1) expectedOwnershipRevision!: number;
}
@UseGuards(AuthenticatedGuard)
@Controller('provider/workspace-entitlements')
export class EntitlementsController {
  constructor(
    private readonly capacity: WorkspaceCapacityQuery,
    private readonly mock: MockPlanActivation,
  ) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie, x-workspace-id')
  read(@Req() request: Request) {
    return this.capacity.run(providerActorFromRequest(request));
  }
  @Post('mock-activation')
  activate(@Req() request: Request, @Body() input: MockActivationDto) {
    return this.mock.activate(providerActorFromRequest(request), input);
  }
}
