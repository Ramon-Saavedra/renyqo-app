import type {
  ApplicantProfile,
  Listing,
  Prisma,
} from '../generated/prisma/client';
import {
  ProfileEligibilityResult as Result,
  ProfileEligibilityCriterion as Criterion,
  ProfileEligibilityOutcome as Outcome,
  type ProfileEligibilityCode as Code,
} from '../generated/prisma/enums';
import { EligibilityResponseDto } from './dto/eligibility-response.dto';

export const PROFILE_EVALUATOR_VERSION = 'profile-prequalification-v2';
export type ListingEligibilityCriteria = Pick<
  Listing,
  | 'minimumHouseholdNetIncome'
  | 'suitableForPeopleCount'
  | 'petsPolicy'
  | 'smokingPolicy'
  | 'schufaRequired'
  | 'incomeProofRequired'
>;
export type ApplicantEligibilityFacts = Pick<
  ApplicantProfile,
  | 'householdNetIncome'
  | 'adultsCount'
  | 'childrenCount'
  | 'peopleCount'
  | 'hasPets'
  | 'isSmoker'
  | 'schufaAvailable'
  | 'incomeProofAvailable'
>;
export type EligibilityCheck = {
  criterion: Criterion;
  outcome: Outcome;
  code: Code | null;
};
export type EvaluatedProfileFacts = {
  profilePresent: boolean;
  householdNetIncome: number | null;
  householdSize: number | null;
  hasPets: boolean | null;
  isSmoker: boolean | null;
  schufaAvailable: boolean | null;
  incomeProofAvailable: boolean | null;
};
type Facts = EvaluatedProfileFacts;
type Rule = {
  criterion: Criterion;
  check(
    criteria: ListingEligibilityCriteria,
    facts: Facts,
  ): Omit<EligibilityCheck, 'criterion'>;
  where(facts: Facts): Prisma.ListingWhereInput;
};
const numberFact = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
const booleanFact = (value: boolean | null | undefined): boolean | null =>
  typeof value === 'boolean' ? value : null;

function normalized(profile: ApplicantEligibilityFacts | null): Facts {
  const adults = numberFact(profile?.adultsCount),
    children = numberFact(profile?.childrenCount);
  const count =
    adults !== null && children !== null
      ? adults + children
      : numberFact(profile?.peopleCount);
  return {
    profilePresent: profile !== null,
    householdNetIncome: numberFact(profile?.householdNetIncome),
    householdSize:
      count !== null && Number.isInteger(count) && count > 0 ? count : null,
    hasPets: booleanFact(profile?.hasPets),
    isSmoker: booleanFact(profile?.isSmoker),
    schufaAvailable: booleanFact(profile?.schufaAvailable),
    incomeProofAvailable: booleanFact(profile?.incomeProofAvailable),
  };
}
const pass = { outcome: Outcome.PASS, code: null };
const inactive = { outcome: Outcome.NOT_APPLICABLE, code: null };

function numericRule(
  criterion: Criterion,
  field: 'minimumHouseholdNetIncome' | 'suitableForPeopleCount',
  fact: 'householdNetIncome' | 'householdSize',
  comparison: 'lte' | 'gte',
  missing: Code,
  failed: Code,
): Rule {
  return {
    criterion,
    check: (c, f) =>
      c[field] === null
        ? inactive
        : f[fact] === null
          ? { outcome: Outcome.UNKNOWN, code: missing }
          : (comparison === 'lte' ? f[fact] >= c[field] : f[fact] <= c[field])
            ? pass
            : { outcome: Outcome.FAIL, code: failed },
    where: (f) =>
      f[fact] === null
        ? { [field]: null }
        : { OR: [{ [field]: null }, { [field]: { [comparison]: f[fact] } }] },
  };
}
function policyRule(
  criterion: Criterion,
  field: 'petsPolicy' | 'smokingPolicy',
  fact: 'hasPets' | 'isSmoker',
  missing: Code,
  prohibited: Code,
  arrangement: Code,
): Rule {
  return {
    criterion,
    check: (c, f) => {
      if (c[field] === null || c[field] === 'ALLOWED') return inactive;
      if (c[field] === 'NOT_ALLOWED')
        return f[fact] === null
          ? { outcome: Outcome.UNKNOWN, code: missing }
          : f[fact]
            ? { outcome: Outcome.FAIL, code: prohibited }
            : pass;
      return f[fact] === false
        ? pass
        : {
            outcome: Outcome.OBSERVATION,
            code: f[fact] === null ? missing : arrangement,
          };
    },
    where: (f) =>
      f[fact] === false
        ? {}
        : { OR: [{ [field]: null }, { [field]: { not: 'NOT_ALLOWED' } }] },
  };
}
function declarationRule(
  criterion: Criterion,
  field: 'schufaRequired' | 'incomeProofRequired',
  fact: 'schufaAvailable' | 'incomeProofAvailable',
  pending: Code,
  unverified: Code,
): Rule {
  return {
    criterion,
    check: (c, f) =>
      c[field]
        ? {
            outcome: Outcome.OBSERVATION,
            code: f[fact] === true ? unverified : pending,
          }
        : inactive,
    where: () => ({}),
  };
}
// Each rule owns its evaluator and SQL translation. All entry points consume this definition.
const rules: readonly Rule[] = [
  {
    criterion: Criterion.PROFILE,
    check: (_c, f) =>
      f.profilePresent
        ? pass
        : { outcome: Outcome.UNKNOWN, code: 'profile_not_available' },
    where: (f) => (f.profilePresent ? {} : { id: { in: [] } }),
  },
  numericRule(
    Criterion.INCOME,
    'minimumHouseholdNetIncome',
    'householdNetIncome',
    'lte',
    'household_income_not_available',
    'household_income_below_requirement',
  ),
  numericRule(
    Criterion.HOUSEHOLD_SIZE,
    'suitableForPeopleCount',
    'householdSize',
    'gte',
    'household_size_not_available',
    'household_size_exceeds_requirement',
  ),
  policyRule(
    Criterion.PETS,
    'petsPolicy',
    'hasPets',
    'pets_information_not_available',
    'pets_not_allowed',
    'pets_by_arrangement',
  ),
  policyRule(
    Criterion.SMOKING,
    'smokingPolicy',
    'isSmoker',
    'smoking_information_not_available',
    'smoking_not_allowed',
    'smoking_by_arrangement',
  ),
  declarationRule(
    Criterion.SCHUFA_DECLARATION,
    'schufaRequired',
    'schufaAvailable',
    'schufa_declaration_pending',
    'schufa_declared_not_verified',
  ),
  declarationRule(
    Criterion.INCOME_PROOF_DECLARATION,
    'incomeProofRequired',
    'incomeProofAvailable',
    'income_proof_declaration_pending',
    'income_proof_declared_not_verified',
  ),
];
export function evaluateProfile(
  criteria: ListingEligibilityCriteria,
  profile: ApplicantEligibilityFacts | null,
  evaluatedAt = new Date(),
): EligibilityResponseDto {
  const facts = normalized(profile);
  const checks = rules.map((rule) => ({
    criterion: rule.criterion,
    ...rule.check(criteria, facts),
  }));
  const result = checks.some((c) => c.outcome === Outcome.FAIL)
    ? Result.NO_MATCH
    : checks.some((c) => c.outcome === Outcome.UNKNOWN)
      ? Result.INSUFFICIENT_INFORMATION
      : checks.some((c) => c.outcome === Outcome.OBSERVATION)
        ? Result.MATCH_WITH_OBSERVATIONS
        : Result.MATCH;
  const reasons = checks
    .filter((c) => c.outcome === Outcome.FAIL || c.outcome === Outcome.UNKNOWN)
    .flatMap((c) => (c.code ? [c.code] : []));
  const observations = checks
    .filter((c) => c.outcome === Outcome.OBSERVATION)
    .flatMap((c) => (c.code ? [c.code] : []));
  // Persist only facts actually used by configured rules, never the full profile.
  const used = {
    ...facts,
    householdNetIncome:
      criteria.minimumHouseholdNetIncome === null
        ? null
        : facts.householdNetIncome,
    householdSize:
      criteria.suitableForPeopleCount === null ? null : facts.householdSize,
    hasPets:
      criteria.petsPolicy === 'NOT_ALLOWED' ||
      criteria.petsPolicy === 'BY_ARRANGEMENT'
        ? facts.hasPets
        : null,
    isSmoker:
      criteria.smokingPolicy === 'NOT_ALLOWED' ||
      criteria.smokingPolicy === 'BY_ARRANGEMENT'
        ? facts.isSmoker
        : null,
    schufaAvailable: criteria.schufaRequired ? facts.schufaAvailable : null,
    incomeProofAvailable: criteria.incomeProofRequired
      ? facts.incomeProofAvailable
      : null,
  };
  return new EligibilityResponseDto(
    result === Result.MATCH || result === Result.MATCH_WITH_OBSERVATIONS,
    reasons,
    observations,
    evaluatedAt,
    result,
    checks,
    used,
  );
}
export function hardProfileMatchWhere(
  profile: ApplicantEligibilityFacts | null,
): Prisma.ListingWhereInput {
  const facts = normalized(profile);
  return { AND: rules.map((rule) => rule.where(facts)) };
}
