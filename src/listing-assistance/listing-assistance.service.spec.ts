import { describe, expect, it, jest } from '@jest/globals';
import { ObjectType } from '../generated/prisma/enums';
import { ListingAssistanceService } from './listing-assistance.service';
import type { AiProvider } from './providers/ai-provider.interface';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';

const file: ListingAssistanceFile = {
  originalname: 'listing.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7'),
};

function createProvider(): jest.Mocked<AiProvider> {
  return {
    extractFromText: jest.fn(),
    extractFromPdf: jest.fn(),
    transcribeAudio: jest.fn(),
  };
}

describe('ListingAssistanceService', () => {
  it('returns valid present values and calculates missing publish fields', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      objectType: ObjectType.APARTMENT,
      city: 'Berlin',
      rooms: 3,
      bedrooms: 2,
      coldRent: 1200,
    });
    const service = new ListingAssistanceService(aiProvider);

    await expect(
      service.extractFromText('Three-room apartment'),
    ).resolves.toEqual(
      expect.objectContaining({
        values: expect.objectContaining({ city: 'Berlin', coldRent: 1200 }),
        missingFields: expect.arrayContaining([
          'title',
          'street',
          'livingArea',
          'availableFrom',
        ]),
        inconsistencies: [],
      }),
    );
  });

  it('removes invalid present values without rejecting partial extraction', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      city: 'Berlin',
      rooms: 1,
      bedrooms: 2,
      coldRent: -1,
    });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Invalid details');

    expect(result.values).toEqual({ city: 'Berlin' });
    expect(result.inconsistencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'bedrooms' }),
        expect.objectContaining({ field: 'coldRent' }),
      ]),
    );
  });

  it('does not retain a deposit without a cold rent', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({ deposit: 2400 });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Deposit is 2400 EUR');

    expect(result.values.deposit).toBeUndefined();
    expect(result.inconsistencies).toContainEqual(
      expect.objectContaining({ field: 'deposit' }),
    );
  });

  it('delegates PDF extraction without persistence', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromPdf.mockResolvedValue({ city: 'Hamburg' });
    const service = new ListingAssistanceService(aiProvider);

    await service.extractFromPdf(file);

    expect(aiProvider.extractFromPdf).toHaveBeenCalledWith(file);
  });

  it('transcribes audio before extracting it as text', async () => {
    const aiProvider = createProvider();
    aiProvider.transcribeAudio.mockResolvedValue('Apartment in Cologne');
    aiProvider.extractFromText.mockResolvedValue({ city: 'Cologne' });
    const service = new ListingAssistanceService(aiProvider);

    await service.extractFromAudio(file);

    expect(aiProvider.transcribeAudio).toHaveBeenCalledWith(file);
    expect(aiProvider.extractFromText).toHaveBeenCalledWith(
      'Apartment in Cologne',
    );
  });
});
