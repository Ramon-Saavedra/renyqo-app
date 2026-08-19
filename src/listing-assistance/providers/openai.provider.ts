import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';
import type { ListingAssistanceFile } from '../listing-assistance-upload.constants';
import { extractionInstructions } from '../listing-extraction.instructions';
import { listingExtractionSchema } from '../listing-extraction.schema';
import {
  isListingExtractionField,
  LISTING_EXTRACTION_FIELDS,
} from '../listing-extraction.policy';
import type {
  AiProvider,
  ListingExtractionCandidate,
  ListingExtractionValues,
} from './ai-provider.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  private readonly logger = new Logger(OpenAiProvider.name);

  constructor(
    @Inject(ConfigService)
    private readonly config: OpenAiConfig,
  ) {
    this.client = new OpenAI({
      apiKey: this.config.getOrThrow('OPENAI_API_KEY'),
      timeout: 30000,
      maxRetries: 0,
    });
  }

  async extractFromText(text: string): Promise<ListingExtractionCandidate> {
    return this.extract(
      [{ role: 'user', content: [{ type: 'input_text', text }] }],
      'text',
    );
  }

  async extractFromPdf(
    file: ListingAssistanceFile,
  ): Promise<ListingExtractionCandidate> {
    const fileData = `data:application/pdf;base64,${file.buffer.toString('base64')}`;

    return this.extract(
      [
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: file.originalname,
              file_data: fileData,
              detail: 'low',
            },
          ],
        },
      ],
      'pdf',
    );
  }

  async transcribeAudio(file: ListingAssistanceFile): Promise<string> {
    try {
      const audio = new File(
        [Uint8Array.from(file.buffer)],
        file.originalname,
        {
          type: file.mimetype,
        },
      );
      const transcription = await this.client.audio.transcriptions.create({
        file: audio,
        model: this.config.getOrThrow('OPENAI_TRANSCRIPTION_MODEL'),
      });

      return transcription.text;
    } catch (error) {
      throw this.toException(error);
    }
  }

  private async extract(
    input: ResponseInput,
    inputType: 'text' | 'pdf',
  ): Promise<ListingExtractionCandidate> {
    const startedAt = Date.now();
    try {
      const response = await this.client.responses.create({
        model: this.config.getOrThrow('OPENAI_LISTING_MODEL'),
        store: false,
        input: [
          { role: 'developer', content: extractionInstructions },
          ...input,
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'listing_extraction_v1',
            strict: true,
            schema: listingExtractionSchema,
          },
        },
      });

      if (response.status === 'incomplete') {
        throw new BadGatewayException('AI extraction response was incomplete');
      }

      const refused = response.output.some(
        (item) =>
          item.type === 'message' &&
          item.content.some((content) => content.type === 'refusal'),
      );
      if (refused) {
        throw new BadGatewayException('AI extraction response was refused');
      }

      const output = response.output_text;
      const parsed: unknown = JSON.parse(output);
      const candidate = this.toCandidate(parsed);
      if (!candidate) {
        throw new BadGatewayException('AI extraction response was invalid');
      }

      this.logger.log(
        JSON.stringify({
          internalTraceId: randomUUID(),
          openAiRequestId: response._request_id ?? null,
          inputType,
          model: this.config.getOrThrow('OPENAI_LISTING_MODEL'),
          schemaVersion: 'listing-extraction-schema-v1',
          instructionsVersion: 'provider-listing-extraction-instructions-v1',
          latencyMs: Date.now() - startedAt,
          valuesCount: Object.values(candidate.values).filter(
            (value) => value !== null,
          ).length,
          conflictingCount: candidate.conflictingFields.length,
          uncertainCount: candidate.uncertainFields.length,
          usage: response.usage ?? null,
        }),
      );
      return candidate;
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }

      throw this.toException(error);
    }
  }

  private toCandidate(value: unknown): ListingExtractionCandidate | null {
    if (!isRecord(value) || !isRecord(value.values)) return null;
    if (!this.isNullableNumber(value.depositEvidence)) return null;
    if (!this.isFieldArray(value.conflictingFields)) return null;
    if (!this.isFieldArray(value.uncertainFields)) return null;

    const values = value.values;
    const fields = LISTING_EXTRACTION_FIELDS;
    if (!fields.every((field) => field in values)) return null;
    if (Object.keys(values).some((field) => !isListingExtractionField(field)))
      return null;

    const numberFields = [
      'livingArea',
      'rooms',
      'coldRent',
      'additionalCosts',
      'minimumHouseholdNetIncome',
    ] as const;
    const integerFields = [
      'bedrooms',
      'depositMonths',
      'suitableForPeopleCount',
    ] as const;
    const stringFields = [
      'city',
      'zip',
      'street',
      'district',
      'availableFrom',
      'title',
      'shortDescription',
    ] as const;
    const booleanFields = ['schufaRequired', 'incomeProofRequired'] as const;
    if (!numberFields.every((field) => this.isNullableNumber(values[field])))
      return null;
    if (!integerFields.every((field) => this.isNullableInteger(values[field])))
      return null;
    if (!stringFields.every((field) => this.isNullableString(values[field])))
      return null;
    if (!booleanFields.every((field) => this.isNullableBoolean(values[field])))
      return null;
    if (!this.isNullableEnum(values.objectType, Object.values(ObjectType)))
      return null;
    if (!this.isNullableEnum(values.petsPolicy, Object.values(PetsPolicy)))
      return null;
    if (
      !this.isNullableEnum(values.smokingPolicy, Object.values(SmokingPolicy))
    )
      return null;

    const objectType = this.readNullableEnum(
      values.objectType,
      Object.values(ObjectType),
    );
    const petsPolicy = this.readNullableEnum(
      values.petsPolicy,
      Object.values(PetsPolicy),
    );
    const smokingPolicy = this.readNullableEnum(
      values.smokingPolicy,
      Object.values(SmokingPolicy),
    );
    const stringValues = [
      values.city,
      values.zip,
      values.street,
      values.district,
      values.availableFrom,
      values.title,
      values.shortDescription,
    ].map((value) => this.readNullableString(value));
    const numberValues = [
      values.livingArea,
      values.rooms,
      values.coldRent,
      values.additionalCosts,
      values.minimumHouseholdNetIncome,
    ].map((value) => this.readNullableNumber(value));
    const integerValues = [
      values.bedrooms,
      values.depositMonths,
      values.suitableForPeopleCount,
    ].map((value) => this.readNullableInteger(value));
    const booleanValues = [
      values.schufaRequired,
      values.incomeProofRequired,
    ].map((value) => this.readNullableBoolean(value));
    if (
      objectType === undefined ||
      petsPolicy === undefined ||
      smokingPolicy === undefined ||
      stringValues.some((value) => value === undefined) ||
      numberValues.some((value) => value === undefined) ||
      integerValues.some((value) => value === undefined) ||
      booleanValues.some((value) => value === undefined)
    )
      return null;

    const [
      city,
      zip,
      street,
      district,
      availableFrom,
      title,
      shortDescription,
    ] = stringValues;
    const [
      livingArea,
      rooms,
      coldRent,
      additionalCosts,
      minimumHouseholdNetIncome,
    ] = numberValues;
    const [bedrooms, depositMonths, suitableForPeopleCount] = integerValues;
    const [schufaRequired, incomeProofRequired] = booleanValues;
    if (
      city === undefined ||
      zip === undefined ||
      street === undefined ||
      district === undefined ||
      availableFrom === undefined ||
      title === undefined ||
      shortDescription === undefined ||
      livingArea === undefined ||
      rooms === undefined ||
      coldRent === undefined ||
      additionalCosts === undefined ||
      minimumHouseholdNetIncome === undefined ||
      bedrooms === undefined ||
      depositMonths === undefined ||
      suitableForPeopleCount === undefined ||
      schufaRequired === undefined ||
      incomeProofRequired === undefined
    )
      return null;

    const typedValues: ListingExtractionValues = {
      objectType,
      city,
      zip,
      street,
      district,
      livingArea,
      rooms,
      bedrooms,
      coldRent,
      additionalCosts,
      depositMonths,
      availableFrom,
      title,
      shortDescription,
      minimumHouseholdNetIncome,
      schufaRequired,
      incomeProofRequired,
      suitableForPeopleCount,
      petsPolicy,
      smokingPolicy,
    };

    return {
      values: typedValues,
      depositEvidence: value.depositEvidence,
      conflictingFields: value.conflictingFields,
      uncertainFields: value.uncertainFields,
    };
  }

  private isNullableNumber(value: unknown): value is number | null {
    return (
      value === null || (typeof value === 'number' && Number.isFinite(value))
    );
  }

  private readNullableNumber(value: unknown): number | null | undefined {
    return this.isNullableNumber(value) ? value : undefined;
  }

  private isNullableInteger(value: unknown): value is number | null {
    return (
      this.isNullableNumber(value) &&
      (value === null || Number.isInteger(value))
    );
  }

  private readNullableInteger(value: unknown): number | null | undefined {
    return this.isNullableInteger(value) ? value : undefined;
  }

  private isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
  }

  private readNullableString(value: unknown): string | null | undefined {
    return this.isNullableString(value) ? value : undefined;
  }

  private isNullableBoolean(value: unknown): value is boolean | null {
    return value === null || typeof value === 'boolean';
  }

  private readNullableBoolean(value: unknown): boolean | null | undefined {
    return this.isNullableBoolean(value) ? value : undefined;
  }

  private isNullableEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
  ): value is T | null {
    return (
      value === null ||
      (typeof value === 'string' && allowed.some((item) => item === value))
    );
  }

  private readNullableEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
  ): T | null | undefined {
    if (value === null) return null;
    return allowed.find((item) => item === value);
  }

  private isFieldArray(
    value: unknown,
  ): value is ListingExtractionCandidate['conflictingFields'] {
    return (
      Array.isArray(value) &&
      value.every(
        (field) => typeof field === 'string' && isListingExtractionField(field),
      )
    );
  }

  private toException(
    error: unknown,
  ):
    | ServiceUnavailableException
    | GatewayTimeoutException
    | BadGatewayException {
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return new GatewayTimeoutException('AI provider timed out');
    }

    if (error instanceof OpenAI.APIConnectionError) {
      return new ServiceUnavailableException('AI provider is unavailable');
    }

    return new BadGatewayException('AI provider request failed');
  }
}
interface OpenAiConfig {
  getOrThrow(
    key:
      | 'OPENAI_API_KEY'
      | 'OPENAI_LISTING_MODEL'
      | 'OPENAI_TRANSCRIPTION_MODEL',
  ): string;
}
