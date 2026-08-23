import type { ListingExtractionField } from '../listing-extraction.policy';
import type {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';

export interface ListingExtractionValues {
  objectType: ObjectType | null;
  city: string | null;
  zip: string | null;
  street: string | null;
  district: string | null;
  livingArea: number | null;
  rooms: number | null;
  bedrooms: number | null;
  coldRent: number | null;
  additionalCosts: number | null;
  depositMonths: number | null;
  availableFrom: string | null;
  title: string | null;
  shortDescription: string | null;
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean | null;
  incomeProofRequired: boolean | null;
  suitableForPeopleCount: number | null;
  petsPolicy: PetsPolicy | null;
  smokingPolicy: SmokingPolicy | null;
}

export interface ListingExtractionCandidate {
  values: ListingExtractionValues;
  depositEvidence: number | null;
  conflictingFields: ListingExtractionField[];
  uncertainFields: ListingExtractionField[];
}

export interface AiProvider {
  extractFromText(
    text: string,
    currentDate: Date,
  ): Promise<ListingExtractionCandidate>;
  extractFromPdf(
    file: ListingAssistanceFile,
    currentDate: Date,
  ): Promise<ListingExtractionCandidate>;
  transcribeAudio(file: ListingAssistanceFile): Promise<string>;
}
import type { ListingAssistanceFile } from '../listing-assistance-upload.constants';
