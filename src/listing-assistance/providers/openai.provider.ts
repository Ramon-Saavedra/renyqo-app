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
import type { ListingAssistanceFile } from '../listing-assistance-upload.constants';
import { toBerlinIsoDate } from '../listing-source-normalizer';
import { extractionInstructions } from '../listing-extraction.instructions';
import { listingExtractionSchema } from '../listing-extraction.schema';
import { listingExtractionSpecificationPrompt } from '../listing-extraction.specification';
import {
  EXTRACTION_INSTRUCTIONS_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  LISTING_EXTRACTION_MAX_OUTPUT_TOKENS,
} from '../listing-extraction.policy';
import type {
  AiProvider,
  ListingExtractionCandidate,
} from './ai-provider.interface';
import { parseListingExtractionCandidate } from './openai-response.parser';

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

  async extractFromText(
    text: string,
    currentDate: Date,
  ): Promise<ListingExtractionCandidate> {
    return this.extract(
      [{ role: 'user', content: [{ type: 'input_text', text }] }],
      'text',
      currentDate,
    );
  }

  async extractFromPdf(
    file: ListingAssistanceFile,
    currentDate: Date,
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
      currentDate,
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
    currentDate: Date,
  ): Promise<ListingExtractionCandidate> {
    const startedAt = Date.now();
    try {
      const response = await this.client.responses.create({
        model: this.config.getOrThrow('OPENAI_LISTING_MODEL'),
        store: false,
        max_output_tokens: LISTING_EXTRACTION_MAX_OUTPUT_TOKENS,
        input: [
          { role: 'developer', content: extractionInstructions },
          { role: 'developer', content: listingExtractionSpecificationPrompt },
          {
            role: 'developer',
            content: `Current backend date in Europe/Berlin: ${toBerlinIsoDate(currentDate)}.`,
          },
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new BadGatewayException('AI extraction response was invalid');
      }
      const candidate = parseListingExtractionCandidate(parsed);
      if (!candidate) {
        throw new BadGatewayException('AI extraction response was invalid');
      }

      this.logger.log(
        JSON.stringify({
          internalTraceId: randomUUID(),
          openAiRequestId: response._request_id ?? null,
          inputType,
          model: this.config.getOrThrow('OPENAI_LISTING_MODEL'),
          schemaVersion: EXTRACTION_SCHEMA_VERSION,
          instructionsVersion: EXTRACTION_INSTRUCTIONS_VERSION,
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
