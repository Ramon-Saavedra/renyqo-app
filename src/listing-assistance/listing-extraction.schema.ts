import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import {
  LISTING_EXTRACTION_FIELDS,
  LISTING_EXTRACTION_STRING_LIMITS,
} from './listing-extraction.policy';

type JsonSchema = Record<string, unknown>;

const nullableString = (maxLength: number) => ({
  type: ['string', 'null'],
  maxLength,
});
const nullableNumber = { type: ['number', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };

export const listingExtractionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    values: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectType: {
          type: ['string', 'null'],
          enum: [...Object.values(ObjectType), null],
        },
        city: nullableString(LISTING_EXTRACTION_STRING_LIMITS.city),
        zip: nullableString(LISTING_EXTRACTION_STRING_LIMITS.zip),
        street: nullableString(LISTING_EXTRACTION_STRING_LIMITS.street),
        district: nullableString(LISTING_EXTRACTION_STRING_LIMITS.district),
        livingArea: nullableNumber,
        rooms: nullableNumber,
        bedrooms: nullableInteger,
        coldRent: nullableNumber,
        additionalCosts: nullableNumber,
        depositMonths: nullableInteger,
        availableFrom: nullableString(
          LISTING_EXTRACTION_STRING_LIMITS.availableFrom,
        ),
        title: nullableString(LISTING_EXTRACTION_STRING_LIMITS.title),
        shortDescription: nullableString(
          LISTING_EXTRACTION_STRING_LIMITS.shortDescription,
        ),
        minimumHouseholdNetIncome: nullableNumber,
        schufaRequired: nullableBoolean,
        incomeProofRequired: nullableBoolean,
        suitableForPeopleCount: nullableInteger,
        petsPolicy: {
          type: ['string', 'null'],
          enum: [...Object.values(PetsPolicy), null],
        },
        smokingPolicy: {
          type: ['string', 'null'],
          enum: [...Object.values(SmokingPolicy), null],
        },
      },
      required: [...LISTING_EXTRACTION_FIELDS],
    },
    depositEvidence: nullableNumber,
    conflictingFields: {
      type: 'array',
      items: { type: 'string', enum: [...LISTING_EXTRACTION_FIELDS] },
      maxItems: LISTING_EXTRACTION_FIELDS.length,
    },
    uncertainFields: {
      type: 'array',
      items: { type: 'string', enum: [...LISTING_EXTRACTION_FIELDS] },
      maxItems: LISTING_EXTRACTION_FIELDS.length,
    },
  },
  required: [
    'values',
    'depositEvidence',
    'conflictingFields',
    'uncertainFields',
  ],
};
