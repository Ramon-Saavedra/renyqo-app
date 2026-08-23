import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { CreateListingDto } from '../listings/dto/create-listing.dto';
import { ListingExtractionIssueDto } from './dto/listing-extraction-issue.dto';
import { ListingExtractionResponseDto } from './dto/listing-extraction-response.dto';
import {
  isListingExtractionField,
  LISTING_SOURCE_MAX_CHARACTERS,
  RECOMMENDED_LISTING_FIELDS,
  REQUIRED_LISTING_PROPERTY_FIELDS,
} from './listing-extraction.policy';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';
import { normalizeListingSource } from './listing-source-normalizer';
import { AI_PROVIDER } from './providers/ai-provider.token';
import type {
  AiProvider,
  ListingExtractionCandidate,
} from './providers/ai-provider.interface';

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function validationIssues(
  errors: ValidationError[],
): ListingExtractionIssueDto[] {
  return errors.flatMap((error) => {
    const messages = Object.values(error.constraints ?? {});
    const field = error.property || 'listing';
    return messages.map(
      (message) => new ListingExtractionIssueDto(field, message),
    );
  });
}

@Injectable()
export class ListingAssistanceService {
  constructor(@Inject(AI_PROVIDER) private readonly aiProvider: AiProvider) {}

  async extractFromText(
    text: string,
    currentDate = new Date(),
  ): Promise<ListingExtractionResponseDto> {
    const candidate = await this.aiProvider.extractFromText(text, currentDate);
    return this.validateExtraction(
      this.mergeDeterministicEvidence(text, candidate, currentDate),
    );
  }

  async extractFromPdf(
    file: ListingAssistanceFile,
    currentDate = new Date(),
  ): Promise<ListingExtractionResponseDto> {
    return this.validateExtraction(
      await this.aiProvider.extractFromPdf(file, currentDate),
    );
  }

  async extractFromAudio(
    file: ListingAssistanceFile,
    currentDate = new Date(),
  ): Promise<ListingExtractionResponseDto> {
    const transcript = await this.aiProvider.transcribeAudio(file);
    if (transcript.length > LISTING_SOURCE_MAX_CHARACTERS) {
      throw new PayloadTooLargeException('Audio transcript is too long');
    }
    const candidate = await this.aiProvider.extractFromText(
      transcript,
      currentDate,
    );
    return this.validateExtraction(
      this.mergeDeterministicEvidence(transcript, candidate, currentDate),
    );
  }

  private mergeDeterministicEvidence(
    text: string,
    candidate: ListingExtractionCandidate,
    currentDate: Date,
  ): ListingExtractionCandidate {
    const normalized = normalizeListingSource(text, currentDate);

    const values = { ...candidate.values };
    const conflictingFields = new Set(candidate.conflictingFields);
    const uncertainFields = new Set(candidate.uncertainFields);

    if (normalized.conflictingFields.includes('livingArea')) {
      conflictingFields.add('livingArea');
      values.livingArea = null;
    } else if (normalized.livingArea !== null) {
      uncertainFields.delete('livingArea');
      if (
        values.livingArea !== null &&
        values.livingArea !== normalized.livingArea
      ) {
        conflictingFields.add('livingArea');
        values.livingArea = null;
      } else {
        values.livingArea = normalized.livingArea;
      }
    }

    if (normalized.conflictingFields.includes('availableFrom')) {
      conflictingFields.add('availableFrom');
      values.availableFrom = null;
    } else if (normalized.uncertainFields.includes('availableFrom')) {
      uncertainFields.add('availableFrom');
      values.availableFrom = null;
    } else if (normalized.availableFrom !== null) {
      uncertainFields.delete('availableFrom');
      if (
        values.availableFrom !== null &&
        values.availableFrom !== normalized.availableFrom
      ) {
        conflictingFields.add('availableFrom');
        values.availableFrom = null;
      } else {
        values.availableFrom = normalized.availableFrom;
      }
    }

    return {
      ...candidate,
      values,
      conflictingFields: Array.from(conflictingFields),
      uncertainFields: Array.from(uncertainFields),
    };
  }

  private async validateExtraction(
    candidate: ListingExtractionCandidate,
  ): Promise<ListingExtractionResponseDto> {
    const rawValues = this.getPresentValues(candidate.values);
    const dto = plainToInstance(CreateListingDto, rawValues, {
      enableImplicitConversion: true,
    });
    const errors = await validate(dto, {
      skipMissingProperties: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const inconsistencies = validationIssues(errors);
    for (const field of candidate.conflictingFields) {
      inconsistencies.push(
        new ListingExtractionIssueDto(
          field,
          'The source contains conflicting values for this field',
        ),
      );
      delete rawValues[field];
    }
    const warnings = candidate.uncertainFields.map(
      (field) => `The source contains an uncertain value for ${field}`,
    );
    for (const field of candidate.uncertainFields) {
      delete rawValues[field];
    }
    const invalidFields = new Set(
      inconsistencies.flatMap((issue) =>
        issue.field === 'listing' ? ['rooms', 'bedrooms'] : [issue.field],
      ),
    );

    for (const field of invalidFields) {
      delete rawValues[field];
    }

    const values = this.toValidatedValues(dto, rawValues);
    this.addBedroomsInconsistency(values, inconsistencies);
    this.addDepositEvidenceInconsistency(
      values,
      candidate.depositEvidence,
      inconsistencies,
    );

    return new ListingExtractionResponseDto({
      values,
      requiredMissingFields: REQUIRED_LISTING_PROPERTY_FIELDS.filter(
        (field) => !isPresent(values[field]),
      ),
      recommendedMissingFields: RECOMMENDED_LISTING_FIELDS.filter(
        (field) => !isPresent(values[field]),
      ),
      inconsistencies,
      warnings,
    });
  }

  private getPresentValues(candidate: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(candidate).filter(
        ([field, value]) => isListingExtractionField(field) && isPresent(value),
      ),
    );
  }

  private toValidatedValues(
    dto: CreateListingDto,
    rawValues: Record<string, unknown>,
  ): Partial<CreateListingDto> {
    const values: Partial<CreateListingDto> = {};

    if ('objectType' in rawValues) values.objectType = dto.objectType;
    if ('city' in rawValues) values.city = dto.city;
    if ('zip' in rawValues) values.zip = dto.zip;
    if ('street' in rawValues) values.street = dto.street;
    if ('district' in rawValues) values.district = dto.district;
    if ('livingArea' in rawValues) values.livingArea = dto.livingArea;
    if ('rooms' in rawValues) values.rooms = dto.rooms;
    if ('bedrooms' in rawValues) values.bedrooms = dto.bedrooms;
    if ('coldRent' in rawValues) values.coldRent = dto.coldRent;
    if ('additionalCosts' in rawValues)
      values.additionalCosts = dto.additionalCosts;
    if ('depositMonths' in rawValues) values.depositMonths = dto.depositMonths;
    if ('availableFrom' in rawValues) values.availableFrom = dto.availableFrom;
    if ('title' in rawValues) values.title = dto.title;
    if ('shortDescription' in rawValues)
      values.shortDescription = dto.shortDescription;
    if ('minimumHouseholdNetIncome' in rawValues)
      values.minimumHouseholdNetIncome = dto.minimumHouseholdNetIncome;
    if ('schufaRequired' in rawValues)
      values.schufaRequired = dto.schufaRequired;
    if ('incomeProofRequired' in rawValues)
      values.incomeProofRequired = dto.incomeProofRequired;
    if ('suitableForPeopleCount' in rawValues)
      values.suitableForPeopleCount = dto.suitableForPeopleCount;
    if ('petsPolicy' in rawValues) values.petsPolicy = dto.petsPolicy;
    if ('smokingPolicy' in rawValues) values.smokingPolicy = dto.smokingPolicy;

    return values;
  }

  private addDepositEvidenceInconsistency(
    values: Partial<CreateListingDto>,
    depositEvidence: number | null,
    inconsistencies: ListingExtractionIssueDto[],
  ): void {
    if (
      depositEvidence === null ||
      values.coldRent === undefined ||
      values.depositMonths === undefined
    ) {
      return;
    }

    const expected =
      Math.round(values.coldRent * values.depositMonths * 100) / 100;
    if (Math.abs(depositEvidence - expected) > 0.01) {
      delete values.coldRent;
      delete values.depositMonths;
      inconsistencies.push(
        new ListingExtractionIssueDto(
          'depositMonths',
          'The explicit deposit amount does not match coldRent multiplied by depositMonths',
        ),
      );
    }
  }

  private addBedroomsInconsistency(
    values: Partial<CreateListingDto>,
    inconsistencies: ListingExtractionIssueDto[],
  ): void {
    if (
      typeof values.rooms !== 'number' ||
      typeof values.bedrooms !== 'number' ||
      values.bedrooms <= values.rooms
    ) {
      return;
    }

    delete values.rooms;
    delete values.bedrooms;
    inconsistencies.push(
      new ListingExtractionIssueDto(
        'bedrooms',
        'bedrooms must not be greater than rooms',
      ),
    );
  }
}
