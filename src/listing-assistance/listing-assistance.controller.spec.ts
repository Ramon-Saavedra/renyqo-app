import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { ListingAssistanceController } from './listing-assistance.controller';
import { ListingAssistanceService } from './listing-assistance.service';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';

const response = {
  values: { city: 'Berlin' },
  requiredMissingFields: ['street'],
  recommendedMissingFields: ['petsPolicy'],
  inconsistencies: [],
  warnings: [],
};

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
    extractFromText: jest.fn<(text: string) => Promise<typeof response>>(),
    extractFromPdf:
      jest.fn<(file: Express.Multer.File) => Promise<typeof response>>(),
    extractFromAudio:
      jest.fn<(file: Express.Multer.File) => Promise<typeof response>>(),
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
    const file: ListingAssistanceFile = {
      originalname: 'listing.webm',
      mimetype: 'audio/webm',
      buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    };

    await expect(controller.extractFromAudio(file)).resolves.toBe(response);
    expect(service.extractFromAudio).toHaveBeenCalledWith(file);
  });
});
