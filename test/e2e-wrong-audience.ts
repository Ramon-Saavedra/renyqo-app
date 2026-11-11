/**
 * Provider HTTP surfaces hide unauthorized access as not-found. Applicant-only
 * routes still reject other roles via ApplicantOnlyGuard (403 Forbidden).
 */
export const wrongAudienceStatus = 404 as const;
export const blockedApplicantRouteStatus = 403 as const;
