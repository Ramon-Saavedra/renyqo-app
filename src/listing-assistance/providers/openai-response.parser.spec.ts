import { describe, expect, it } from '@jest/globals';
import type {
  ListingExtractionCandidate,
  ListingExtractionValues,
} from './ai-provider.interface';
import { parseListingExtractionCandidate } from './openai-response.parser';

function values(
  overrides: Partial<ListingExtractionValues> = {},
): ListingExtractionValues {
  return {
    objectType: null,
    city: null,
    zip: null,
    street: null,
    district: null,
    livingArea: null,
    rooms: null,
    bedrooms: null,
    coldRent: null,
    additionalCosts: null,
    depositMonths: null,
    availableFrom: null,
    title: null,
    shortDescription: null,
    minimumHouseholdNetIncome: null,
    schufaRequired: null,
    incomeProofRequired: null,
    suitableForPeopleCount: null,
    petsPolicy: null,
    smokingPolicy: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ListingExtractionValues> = {},
): ListingExtractionCandidate {
  return {
    values: values(overrides),
    depositEvidence: null,
    conflictingFields: [],
    uncertainFields: [],
  };
}

describe('parseListingExtractionCandidate', () => {
  it('returns a typed candidate for a valid structured response', () => {
    expect(
      parseListingExtractionCandidate(candidate({ city: 'Berlin' })),
    ).toEqual(candidate({ city: 'Berlin' }));
  });

  it('rejects missing, additional, and invalid fields', () => {
    const missingField = { ...candidate(), values: { city: null } };
    const additionalField = {
      ...candidate(),
      values: { ...values(), unsupported: 'value' },
    };
    const invalidField = {
      ...candidate(),
      values: { ...values(), livingArea: '100' },
    };
    const additionalTopLevelField = {
      ...candidate(),
      unsupported: 'value',
    };

    expect(parseListingExtractionCandidate(missingField)).toBeNull();
    expect(parseListingExtractionCandidate(additionalField)).toBeNull();
    expect(parseListingExtractionCandidate(invalidField)).toBeNull();
    expect(parseListingExtractionCandidate(additionalTopLevelField)).toBeNull();
  });

  it('rejects unsupported conflict and uncertainty fields', () => {
    expect(
      parseListingExtractionCandidate({
        ...candidate(),
        conflictingFields: ['unsupported'],
      }),
    ).toBeNull();
    expect(
      parseListingExtractionCandidate({
        ...candidate(),
        uncertainFields: ['unsupported'],
      }),
    ).toBeNull();
  });

  it('rejects oversized strings and duplicate issue fields', () => {
    expect(
      parseListingExtractionCandidate(candidate({ title: 'x'.repeat(201) })),
    ).toBeNull();
    expect(
      parseListingExtractionCandidate({
        ...candidate(),
        conflictingFields: ['city', 'city'],
      }),
    ).toBeNull();
  });
});
