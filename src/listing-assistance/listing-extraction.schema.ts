import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { LISTING_EXTRACTION_FIELDS } from './listing-extraction.policy';

type JsonSchema = Record<string, unknown>;

const nullableString = { type: ['string', 'null'] };
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
        city: nullableString,
        zip: nullableString,
        street: nullableString,
        district: nullableString,
        livingArea: nullableNumber,
        rooms: nullableNumber,
        bedrooms: nullableInteger,
        coldRent: nullableNumber,
        additionalCosts: nullableNumber,
        depositMonths: nullableInteger,
        availableFrom: nullableString,
        title: nullableString,
        shortDescription: nullableString,
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
    },
    uncertainFields: {
      type: 'array',
      items: { type: 'string', enum: [...LISTING_EXTRACTION_FIELDS] },
    },
  },
  required: [
    'values',
    'depositEvidence',
    'conflictingFields',
    'uncertainFields',
  ],
};
