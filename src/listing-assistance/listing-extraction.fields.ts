export const LISTING_EXTRACTION_FIELDS = [
  'objectType',
  'city',
  'zip',
  'street',
  'district',
  'showExactAddress',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'additionalCosts',
  'deposit',
  'depositMonths',
  'availableFrom',
  'title',
  'shortDescription',
  'minimumHouseholdNetIncome',
  'schufaRequired',
  'incomeProofRequired',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
] as const;

export function isListingExtractionField(field: string): boolean {
  return LISTING_EXTRACTION_FIELDS.some(
    (supportedField) => supportedField === field,
  );
}
