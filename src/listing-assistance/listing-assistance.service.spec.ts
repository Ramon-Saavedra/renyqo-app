import { describe, expect, it, jest } from '@jest/globals';
import { ObjectType } from '../generated/prisma/enums';
import { ListingAssistanceService } from './listing-assistance.service';
import type { AiProvider } from './providers/ai-provider.interface';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';
import type { ListingExtractionCandidate } from './providers/ai-provider.interface';

const file: ListingAssistanceFile = {
  originalname: 'listing.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7'),
};

function candidate(
  values: Record<string, unknown>,
): ListingExtractionCandidate {
  return {
    values: {
      objectType:
        (values.objectType as ListingExtractionCandidate['values']['objectType']) ??
        null,
      city: (values.city as string) ?? null,
      zip: (values.zip as string) ?? null,
      street: (values.street as string) ?? null,
      district: (values.district as string) ?? null,
      livingArea: (values.livingArea as number) ?? null,
      rooms: (values.rooms as number) ?? null,
      bedrooms: (values.bedrooms as number) ?? null,
      coldRent: (values.coldRent as number) ?? null,
      additionalCosts: (values.additionalCosts as number) ?? null,
      depositMonths: (values.depositMonths as number) ?? null,
      availableFrom: (values.availableFrom as string) ?? null,
      title: (values.title as string) ?? null,
      shortDescription: (values.shortDescription as string) ?? null,
      minimumHouseholdNetIncome:
        (values.minimumHouseholdNetIncome as number) ?? null,
      schufaRequired: (values.schufaRequired as boolean) ?? null,
      incomeProofRequired: (values.incomeProofRequired as boolean) ?? null,
      suitableForPeopleCount: (values.suitableForPeopleCount as number) ?? null,
      petsPolicy:
        (values.petsPolicy as ListingExtractionCandidate['values']['petsPolicy']) ??
        null,
      smokingPolicy:
        (values.smokingPolicy as ListingExtractionCandidate['values']['smokingPolicy']) ??
        null,
    },
    depositEvidence: null,
    conflictingFields: [],
    uncertainFields: [],
  };
}

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
    aiProvider.extractFromText.mockResolvedValue(
      candidate({
        objectType: ObjectType.APARTMENT,
        city: 'Berlin',
        rooms: 3,
        bedrooms: 2,
        coldRent: 1200,
      }),
    );
    const service = new ListingAssistanceService(aiProvider);

    await expect(
      service.extractFromText('Three-room apartment'),
    ).resolves.toEqual(
      expect.objectContaining({
        values: expect.objectContaining({ city: 'Berlin', coldRent: 1200 }),
        requiredMissingFields: expect.arrayContaining([
          'zip',
          'street',
          'livingArea',
          'availableFrom',
        ]),
        recommendedMissingFields: expect.arrayContaining(['petsPolicy']),
        inconsistencies: [],
      }),
    );
  });

  it('removes invalid present values without rejecting partial extraction', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(
      candidate({
        city: 'Berlin',
        rooms: 1,
        bedrooms: 2,
        coldRent: -1,
      }),
    );
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
    aiProvider.extractFromText.mockResolvedValue(candidate({}));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Deposit is 2400 EUR');

    expect(result.values.deposit).toBeUndefined();
    expect(result.inconsistencies).toEqual([]);
  });

  it('delegates PDF extraction without persistence', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromPdf.mockResolvedValue(candidate({ city: 'Hamburg' }));
    const service = new ListingAssistanceService(aiProvider);

    await service.extractFromPdf(file);

    expect(aiProvider.extractFromPdf).toHaveBeenCalledWith(file);
  });

  it('transcribes audio before extracting it as text', async () => {
    const aiProvider = createProvider();
    aiProvider.transcribeAudio.mockResolvedValue('Apartment in Cologne');
    aiProvider.extractFromText.mockResolvedValue(
      candidate({ city: 'Cologne' }),
    );
    const service = new ListingAssistanceService(aiProvider);

    await service.extractFromAudio(file);

    expect(aiProvider.transcribeAudio).toHaveBeenCalledWith(file);
    expect(aiProvider.extractFromText).toHaveBeenCalledWith(
      'Apartment in Cologne',
    );
  });

  it('removes conflicting and uncertain fields and reports both categories', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      ...candidate({ city: 'Berlin', rooms: 3, title: 'Listing' }),
      conflictingFields: ['rooms'],
      uncertainFields: ['city'],
    });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Conflicting listing');

    expect(result.values).toEqual({ title: 'Listing' });
    expect(result.inconsistencies).toContainEqual(
      expect.objectContaining({ field: 'rooms' }),
    );
    expect(result.warnings).toEqual([
      'The source contains an uncertain value for city',
    ]);
  });

  it('checks explicit deposit evidence without exposing a derived deposit', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      ...candidate({ coldRent: 1450, depositMonths: 3 }),
      depositEvidence: 4000,
    });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Kaution 4000 EUR');

    expect(result.values).toEqual({});
    expect(result.values.deposit).toBeUndefined();
    expect(result.inconsistencies).toContainEqual(
      expect.objectContaining({ field: 'depositMonths' }),
    );
  });
});
