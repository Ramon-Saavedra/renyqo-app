import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { CreateListingDto } from '../listings/dto/create-listing.dto';
import { ListingExtractionIssueDto } from './dto/listing-extraction-issue.dto';
import { ListingExtractionResponseDto } from './dto/listing-extraction-response.dto';
import { isListingExtractionField } from './listing-extraction.fields';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';
import { AI_PROVIDER } from './providers/ai-provider.token';
import type {
  AiProvider,
  ListingExtractionCandidate,
} from './providers/ai-provider.interface';

const PUBLISH_REQUIRED_FIELDS = [
  'title',
  'street',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'availableFrom',
] as const;

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

  async extractFromText(text: string): Promise<ListingExtractionResponseDto> {
    return this.validateExtraction(await this.aiProvider.extractFromText(text));
  }

  async extractFromPdf(
    file: ListingAssistanceFile,
  ): Promise<ListingExtractionResponseDto> {
    return this.validateExtraction(await this.aiProvider.extractFromPdf(file));
  }

  async extractFromAudio(
    file: ListingAssistanceFile,
  ): Promise<ListingExtractionResponseDto> {
    const transcript = await this.aiProvider.transcribeAudio(file);
    return this.extractFromText(transcript);
  }

  private async validateExtraction(
    candidate: ListingExtractionCandidate,
  ): Promise<ListingExtractionResponseDto> {
    const rawValues = this.getPresentValues(candidate);
    const dto = plainToInstance(CreateListingDto, rawValues, {
      enableImplicitConversion: true,
    });
    const errors = await validate(dto, {
      skipMissingProperties: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const inconsistencies = validationIssues(errors);
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
    this.addDepositInconsistencies(values, inconsistencies);

    return new ListingExtractionResponseDto({
      values,
      missingFields: PUBLISH_REQUIRED_FIELDS.filter(
        (field) => !isPresent(values[field]),
      ),
      inconsistencies,
      warnings: [],
    });
  }

  private getPresentValues(
    candidate: ListingExtractionCandidate,
  ): Record<string, unknown> {
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
    if ('showExactAddress' in rawValues)
      values.showExactAddress = dto.showExactAddress;
    if ('livingArea' in rawValues) values.livingArea = dto.livingArea;
    if ('rooms' in rawValues) values.rooms = dto.rooms;
    if ('bedrooms' in rawValues) values.bedrooms = dto.bedrooms;
    if ('coldRent' in rawValues) values.coldRent = dto.coldRent;
    if ('additionalCosts' in rawValues)
      values.additionalCosts = dto.additionalCosts;
    if ('deposit' in rawValues) values.deposit = dto.deposit;
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

  private addDepositInconsistencies(
    values: Partial<CreateListingDto>,
    inconsistencies: ListingExtractionIssueDto[],
  ): void {
    if (values.deposit !== undefined && values.coldRent === undefined) {
      delete values.deposit;
      inconsistencies.push(
        new ListingExtractionIssueDto(
          'deposit',
          'coldRent is required when deposit is provided',
        ),
      );
      return;
    }

    if (
      values.deposit === undefined ||
      values.coldRent === undefined ||
      typeof values.deposit !== 'number' ||
      typeof values.coldRent !== 'number'
    ) {
      return;
    }

    const depositMonths = values.depositMonths ?? 2;
    if (typeof depositMonths !== 'number') {
      return;
    }

    const expected = Math.round(values.coldRent * depositMonths * 100) / 100;
    if (Math.abs(values.deposit - expected) > 0.01) {
      delete values.deposit;
      inconsistencies.push(
        new ListingExtractionIssueDto(
          'deposit',
          'deposit must equal coldRent multiplied by depositMonths',
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
