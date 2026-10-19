import { IsIn, IsOptional } from 'class-validator';
import { ReadModelPageQueryDto } from './read-model-input.dto';

export const APPLICANT_APPLICATION_OVERVIEW_GROUPS = [
  'ALL',
  'ACTIVE',
  'WAITING',
  'DONE',
] as const;

export type ApplicantApplicationOverviewGroup =
  (typeof APPLICANT_APPLICATION_OVERVIEW_GROUPS)[number];

export type ApplicantApplicationOverviewQuery = ReadModelPageQueryDto & {
  group?: ApplicantApplicationOverviewGroup;
};

export class ApplicantApplicationOverviewQueryDto extends ReadModelPageQueryDto {
  @IsOptional()
  @IsIn(APPLICANT_APPLICATION_OVERVIEW_GROUPS)
  group?: ApplicantApplicationOverviewGroup;
}
