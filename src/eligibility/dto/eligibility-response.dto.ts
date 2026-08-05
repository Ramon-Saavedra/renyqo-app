export type EligibilityReason =
  | 'household_income_not_available'
  | 'household_income_below_requirement'
  | 'schufa_required_but_not_available'
  | 'income_proof_required_but_not_available'
  | 'household_size_not_available'
  | 'household_size_exceeds_requirement'
  | 'pets_not_allowed';

export type EligibilityWarning =
  | 'pets_by_arrangement'
  | 'smoking_by_arrangement'
  | 'smoking_not_preferred';

export class EligibilityResponseDto {
  readonly canApply!: boolean;
  readonly reasons!: EligibilityReason[];
  readonly warnings!: EligibilityWarning[];
  readonly evaluatedAt!: Date;

  constructor(
    canApply: boolean,
    reasons: readonly EligibilityReason[],
    warnings: readonly EligibilityWarning[],
    evaluatedAt: Date,
  ) {
    Object.assign(this, {
      canApply,
      reasons: [...reasons],
      warnings: [...warnings],
      evaluatedAt,
    });
  }
}
