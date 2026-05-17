export type ProviderOnboardingState = {
  role: 'provider';
  hasCreatedFirstListing: boolean;
  nextStep: 'create_first_listing' | 'dashboard';
};

export type ApplicantOnboardingState = {
  role: 'applicant';
  nextStep: 'applicant_area_pending';
};

export type OnboardingState =
  | ProviderOnboardingState
  | ApplicantOnboardingState;
