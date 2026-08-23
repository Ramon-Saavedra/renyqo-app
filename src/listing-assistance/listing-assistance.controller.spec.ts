import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { ListingAssistanceController } from './listing-assistance.controller';
import { ListingAssistanceService } from './listing-assistance.service';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';
import { ListingExtractionResponseDto } from './dto/listing-extraction-response.dto';

const response = new ListingExtractionResponseDto({
  values: { city: 'Berlin' },
  requiredMissingFields: ['street'],
  recommendedMissingFields: ['petsPolicy'],
  inconsistencies: [],
  warnings: [],
});

function createController(): {
  controller: ListingAssistanceController;
  service: jest.Mocked<
    Pick<
      ListingAssistanceService,
      'extractFromText' | 'extractFromPdf' | 'extractFromAudio'
    >
  >;
} {
  const service = {
    extractFromText:
      jest.fn<(text: string) => Promise<ListingExtractionResponseDto>>(),
    extractFromPdf:
      jest.fn<
        (file: ListingAssistanceFile) => Promise<ListingExtractionResponseDto>
      >(),
    extractFromAudio:
      jest.fn<
        (file: ListingAssistanceFile) => Promise<ListingExtractionResponseDto>
      >(),
  };

  return {
    controller: new ListingAssistanceController(service),
    service,
  };
}

describe('ListingAssistanceController', () => {
  it('delegates text extraction without creating a listing', async () => {
    const { controller, service } = createController();
    service.extractFromText.mockResolvedValue(response);

    await expect(
      controller.extractFromText({ text: 'Apartment in Berlin' }),
    ).resolves.toBe(response);
    expect(service.extractFromText).toHaveBeenCalledWith('Apartment in Berlin');
  });

  it('rejects a PDF whose bytes do not contain the PDF signature', async () => {
    const { controller } = createController();
    const file: ListingAssistanceFile = {
      originalname: 'listing.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('invalid'),
    };

    await expect(controller.extractFromPdf(file)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('delegates audio extraction without a listing identifier', async () => {
    const { controller, service } = createController();
    service.extractFromAudio.mockResolvedValue(response);
    const buffer = Buffer.alloc(46);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(38, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24);
    buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(2, 40);
    const file: ListingAssistanceFile = {
      originalname: 'listing.wav',
      mimetype: 'audio/wav',
      buffer,
    };

    await expect(controller.extractFromAudio(file)).resolves.toBe(response);
    expect(service.extractFromAudio).toHaveBeenCalledWith(file);
  });
});
