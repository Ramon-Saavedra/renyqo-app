import { GatewayTimeoutException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import OpenAI from 'openai';
import { OpenAiProvider } from './openai.provider';
import type { ListingAssistanceFile } from '../listing-assistance-upload.constants';

function createProvider(
  responsesCreate: jest.Mock<(input: unknown) => Promise<unknown>>,
  transcriptionCreate: jest.Mock<
    (input: unknown) => Promise<unknown>
  > = jest.fn<(input: unknown) => Promise<unknown>>(),
): OpenAiProvider {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        OPENAI_API_KEY: 'test-key',
        OPENAI_LISTING_MODEL: 'listing-model',
        OPENAI_TRANSCRIPTION_MODEL: 'transcription-model',
      };
      return values[key];
    }),
  };
  const provider = new OpenAiProvider(config);

  Object.defineProperty(provider, 'client', {
    value: {
      responses: { create: responsesCreate },
      audio: { transcriptions: { create: transcriptionCreate } },
    },
  });

  return provider;
}

describe('OpenAiProvider', () => {
  it('uses structured output and disables response storage', async () => {
    const responsesCreate = jest
      .fn<(input: unknown) => Promise<unknown>>()
      .mockResolvedValue({
        status: 'completed',
        output_text: '{"city":"Berlin"}',
        output: [],
      });
    const provider = createProvider(responsesCreate);

    await expect(
      provider.extractFromText('Apartment in Berlin'),
    ).resolves.toEqual({
      city: 'Berlin',
    });

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'listing-model',
        store: false,
        text: expect.objectContaining({
          format: expect.objectContaining({
            type: 'json_schema',
            strict: true,
          }),
        }),
      }),
    );
  });

  it('sends PDFs directly to Responses without creating an OpenAI file', async () => {
    const responsesCreate = jest
      .fn<(input: unknown) => Promise<unknown>>()
      .mockResolvedValue({
        status: 'completed',
        output_text: '{}',
        output: [],
      });
    const provider = createProvider(responsesCreate);
    const file: ListingAssistanceFile = {
      originalname: 'listing.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    };

    await provider.extractFromPdf(file);

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'input_file',
                filename: 'listing.pdf',
                file_data: expect.stringMatching(
                  /^data:application\/pdf;base64,/,
                ),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('maps OpenAI timeouts to a gateway timeout', async () => {
    const responsesCreate = jest
      .fn<(input: unknown) => Promise<unknown>>()
      .mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const provider = createProvider(responsesCreate);

    await expect(provider.extractFromText('Apartment')).rejects.toThrow(
      GatewayTimeoutException,
    );
  });
});
