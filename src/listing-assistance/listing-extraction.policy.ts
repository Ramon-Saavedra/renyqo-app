export const REQUIRED_LISTING_PROPERTY_FIELDS = [
  'street',
  'zip',
  'city',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'availableFrom',
] as const;

export type RequiredListingPropertyField =
  (typeof REQUIRED_LISTING_PROPERTY_FIELDS)[number];

export const RECOMMENDED_LISTING_FIELDS = [
  'minimumHouseholdNetIncome',
  'schufaRequired',
  'incomeProofRequired',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
] as const;

export type RecommendedListingField =
  (typeof RECOMMENDED_LISTING_FIELDS)[number];

export type ListingExtractionField =
  | 'objectType'
  | 'city'
  | 'zip'
  | 'street'
  | 'district'
  | 'livingArea'
  | 'rooms'
  | 'bedrooms'
  | 'coldRent'
  | 'additionalCosts'
  | 'depositMonths'
  | 'availableFrom'
  | 'title'
  | 'shortDescription'
  | 'minimumHouseholdNetIncome'
  | 'schufaRequired'
  | 'incomeProofRequired'
  | 'suitableForPeopleCount'
  | 'petsPolicy'
  | 'smokingPolicy';

export const LISTING_EXTRACTION_FIELDS = [
  'objectType',
  'city',
  'zip',
  'street',
  'district',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'additionalCosts',
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
] as const satisfies readonly ListingExtractionField[];

export const EXTRACTION_SPEC_VERSION = 'listing-extraction-spec-v1';
export const EXTRACTION_INSTRUCTIONS_VERSION =
  'provider-listing-extraction-instructions-v2';
export const EXTRACTION_SCHEMA_VERSION = 'listing-extraction-schema-v1';
export const LISTING_SOURCE_MAX_CHARACTERS = 20000;
export const LISTING_EXTRACTION_MAX_OUTPUT_TOKENS = 2000;
export const LISTING_EXTRACTION_STRING_LIMITS = {
  city: 120,
  zip: 20,
  street: 200,
  district: 120,
  availableFrom: 32,
  title: 200,
  shortDescription: 2000,
} as const;

export function isListingExtractionField(
  field: string,
): field is ListingExtractionField {
  return LISTING_EXTRACTION_FIELDS.some(
    (supportedField) => supportedField === field,
  );
}
