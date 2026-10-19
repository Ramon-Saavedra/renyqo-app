import type { EligibilityResponseDto } from './eligibility-response.dto';

/** Public applicant projection; detailed evaluations remain internal. */
export class ApplicantEligibilityResponseDto {
  readonly canApply: boolean;
  readonly evaluatedAt: Date;

  constructor(
    evaluation: Pick<EligibilityResponseDto, 'canApply' | 'evaluatedAt'>,
  ) {
    this.canApply = evaluation.canApply;
    this.evaluatedAt = evaluation.evaluatedAt;
  }
}
