import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';
import {
  isListingExtractionField,
  LISTING_EXTRACTION_FIELDS,
  LISTING_EXTRACTION_STRING_LIMITS,
} from '../listing-extraction.policy';
import type {
  ListingExtractionCandidate,
  ListingExtractionValues,
} from './ai-provider.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function isNullableInteger(value: unknown): value is number | null {
  return isNullableNumber(value) && (value === null || Number.isInteger(value));
}

function isNullableString(
  value: unknown,
  maxLength: number,
): value is string | null {
  return (
    value === null || (typeof value === 'string' && value.length <= maxLength)
  );
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | null {
  return (
    value === null ||
    (typeof value === 'string' && allowed.some((item) => item === value))
  );
}

function isFieldArray(
  value: unknown,
): value is ListingExtractionCandidate['conflictingFields'] {
  return (
    Array.isArray(value) &&
    value.length <= LISTING_EXTRACTION_FIELDS.length &&
    new Set(value).size === value.length &&
    value.every(
      (field) => typeof field === 'string' && isListingExtractionField(field),
    )
  );
}

function parseValues(
  value: Record<string, unknown>,
): ListingExtractionValues | null {
  if (!LISTING_EXTRACTION_FIELDS.every((field) => field in value)) return null;
  if (Object.keys(value).some((field) => !isListingExtractionField(field))) {
    return null;
  }

  if (!isNullableEnum(value.objectType, Object.values(ObjectType))) return null;
  if (!isNullableString(value.city, LISTING_EXTRACTION_STRING_LIMITS.city)) {
    return null;
  }
  if (!isNullableString(value.zip, LISTING_EXTRACTION_STRING_LIMITS.zip)) {
    return null;
  }
  if (
    !isNullableString(value.street, LISTING_EXTRACTION_STRING_LIMITS.street)
  ) {
    return null;
  }
  if (
    !isNullableString(value.district, LISTING_EXTRACTION_STRING_LIMITS.district)
  ) {
    return null;
  }
  if (!isNullableNumber(value.livingArea)) return null;
  if (!isNullableNumber(value.rooms)) return null;
  if (!isNullableInteger(value.bedrooms)) return null;
  if (!isNullableNumber(value.coldRent)) return null;
  if (!isNullableNumber(value.additionalCosts)) return null;
  if (!isNullableInteger(value.depositMonths)) return null;
  if (
    !isNullableString(
      value.availableFrom,
      LISTING_EXTRACTION_STRING_LIMITS.availableFrom,
    )
  ) {
    return null;
  }
  if (!isNullableString(value.title, LISTING_EXTRACTION_STRING_LIMITS.title)) {
    return null;
  }
  if (
    !isNullableString(
      value.shortDescription,
      LISTING_EXTRACTION_STRING_LIMITS.shortDescription,
    )
  ) {
    return null;
  }
  if (!isNullableNumber(value.minimumHouseholdNetIncome)) return null;
  if (!isNullableBoolean(value.schufaRequired)) return null;
  if (!isNullableBoolean(value.incomeProofRequired)) return null;
  if (!isNullableInteger(value.suitableForPeopleCount)) return null;
  if (!isNullableEnum(value.petsPolicy, Object.values(PetsPolicy))) return null;
  if (!isNullableEnum(value.smokingPolicy, Object.values(SmokingPolicy))) {
    return null;
  }

  return {
    objectType: value.objectType,
    city: value.city,
    zip: value.zip,
    street: value.street,
    district: value.district,
    livingArea: value.livingArea,
    rooms: value.rooms,
    bedrooms: value.bedrooms,
    coldRent: value.coldRent,
    additionalCosts: value.additionalCosts,
    depositMonths: value.depositMonths,
    availableFrom: value.availableFrom,
    title: value.title,
    shortDescription: value.shortDescription,
    minimumHouseholdNetIncome: value.minimumHouseholdNetIncome,
    schufaRequired: value.schufaRequired,
    incomeProofRequired: value.incomeProofRequired,
    suitableForPeopleCount: value.suitableForPeopleCount,
    petsPolicy: value.petsPolicy,
    smokingPolicy: value.smokingPolicy,
  };
}

export function parseListingExtractionCandidate(
  value: unknown,
): ListingExtractionCandidate | null {
  if (!isRecord(value) || !isRecord(value.values)) return null;
  const candidateFields = [
    'values',
    'depositEvidence',
    'conflictingFields',
    'uncertainFields',
  ];
  if (
    candidateFields.some((field) => !(field in value)) ||
    Object.keys(value).some((field) => !candidateFields.includes(field))
  ) {
    return null;
  }
  if (!isNullableNumber(value.depositEvidence)) return null;
  if (!isFieldArray(value.conflictingFields)) return null;
  if (!isFieldArray(value.uncertainFields)) return null;

  const values = parseValues(value.values);
  if (!values) return null;

  return {
    values,
    depositEvidence: value.depositEvidence,
    conflictingFields: value.conflictingFields,
    uncertainFields: value.uncertainFields,
  };
}
