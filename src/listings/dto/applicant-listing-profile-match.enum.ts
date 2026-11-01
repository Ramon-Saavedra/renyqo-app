import { ProfileEligibilityResult } from '../../generated/prisma/enums';
export enum ProfileMatch {
  MATCH = 'MATCH',
  MATCH_WITH_OBSERVATIONS = 'MATCH_WITH_OBSERVATIONS',
  NO_MATCH = 'NO_MATCH',
  PROFILE_INCOMPLETE = 'PROFILE_INCOMPLETE',
  UNKNOWN = 'UNKNOWN',
}

export function toProfileMatch(result: ProfileEligibilityResult): ProfileMatch {
  switch (result) {
    case ProfileEligibilityResult.MATCH:
      return ProfileMatch.MATCH;
    case ProfileEligibilityResult.MATCH_WITH_OBSERVATIONS:
      return ProfileMatch.MATCH_WITH_OBSERVATIONS;
    case ProfileEligibilityResult.NO_MATCH:
      return ProfileMatch.NO_MATCH;
    case ProfileEligibilityResult.INSUFFICIENT_INFORMATION:
      return ProfileMatch.PROFILE_INCOMPLETE;
  }
}
