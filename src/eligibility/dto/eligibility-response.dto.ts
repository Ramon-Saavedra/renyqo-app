import { ProfileEligibilityResult } from '../../generated/prisma/enums';
import type { ProfileEligibilityCode } from '../../generated/prisma/enums';
import type {
  EligibilityCheck,
  EvaluatedProfileFacts,
} from '../profile-eligibility-evaluator';
export type EligibilityReason = ProfileEligibilityCode;
export type EligibilityWarning = ProfileEligibilityCode;

export class EligibilityResponseDto {
  readonly result: ProfileEligibilityResult;
  readonly checks: readonly EligibilityCheck[];
  readonly facts: EvaluatedProfileFacts;
  readonly canApply!: boolean;
  readonly reasons!: EligibilityReason[];
  readonly warnings!: EligibilityWarning[];
  readonly evaluatedAt!: Date;

  constructor(
    canApply: boolean,
    reasons: readonly EligibilityReason[],
    warnings: readonly EligibilityWarning[],
    evaluatedAt: Date,
    result: ProfileEligibilityResult = canApply
      ? warnings.length
        ? ProfileEligibilityResult.MATCH_WITH_OBSERVATIONS
        : ProfileEligibilityResult.MATCH
      : ProfileEligibilityResult.NO_MATCH,
    checks: readonly EligibilityCheck[] = [],
    facts: EvaluatedProfileFacts = {
      profilePresent: false,
      householdNetIncome: null,
      householdSize: null,
      hasPets: null,
      isSmoker: null,
      schufaAvailable: null,
      incomeProofAvailable: null,
    },
  ) {
    this.result = result;
    this.checks = checks;
    this.facts = facts;
    Object.assign(this, {
      canApply,
      reasons: [...reasons],
      warnings: [...warnings],
      evaluatedAt,
    });
  }
}
