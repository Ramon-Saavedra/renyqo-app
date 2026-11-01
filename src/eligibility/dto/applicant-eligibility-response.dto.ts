import type { EligibilityResponseDto } from './eligibility-response.dto';
import { ProfileEligibilityResult } from '../../generated/prisma/enums';

/** Public applicant projection; detailed evaluations remain internal. */
export class ApplicantEligibilityResponseDto {
  readonly canApply: boolean;
  readonly evaluatedAt: Date;
  readonly result: ProfileEligibilityResult;

  constructor(
    evaluation: Pick<EligibilityResponseDto, 'canApply' | 'evaluatedAt'> &
      Partial<Pick<EligibilityResponseDto, 'result'>>,
  ) {
    this.canApply = evaluation.canApply;
    this.evaluatedAt = evaluation.evaluatedAt;
    this.result =
      evaluation.result ??
      (evaluation.canApply
        ? ProfileEligibilityResult.MATCH
        : ProfileEligibilityResult.NO_MATCH);
  }
}
