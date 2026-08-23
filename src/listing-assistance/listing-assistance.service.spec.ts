import { PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { ObjectType } from '../generated/prisma/enums';
import { ListingAssistanceService } from './listing-assistance.service';
import type { AiProvider } from './providers/ai-provider.interface';
import type { ListingAssistanceFile } from './listing-assistance-upload.constants';
import type { ListingExtractionCandidate } from './providers/ai-provider.interface';
import type { ListingExtractionValues } from './providers/ai-provider.interface';
import { LISTING_SOURCE_MAX_CHARACTERS } from './listing-extraction.policy';
import { toBerlinIsoDate } from './listing-source-normalizer';

const file: ListingAssistanceFile = {
  originalname: 'listing.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7'),
};

function candidate(
  values: Partial<ListingExtractionValues>,
): ListingExtractionCandidate {
  return {
    values: {
      objectType: null,
      city: null,
      zip: null,
      street: null,
      district: null,
      livingArea: null,
      rooms: null,
      bedrooms: null,
      coldRent: null,
      additionalCosts: null,
      depositMonths: null,
      availableFrom: null,
      title: null,
      shortDescription: null,
      minimumHouseholdNetIncome: null,
      schufaRequired: null,
      incomeProofRequired: null,
      suitableForPeopleCount: null,
      petsPolicy: null,
      smokingPolicy: null,
      ...values,
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

    expect(aiProvider.extractFromPdf).toHaveBeenCalledWith(
      file,
      expect.any(Date),
    );
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
      expect.any(Date),
    );
  });

  it('rejects oversized audio transcripts before extraction', async () => {
    const aiProvider = createProvider();
    aiProvider.transcribeAudio.mockResolvedValue(
      'x'.repeat(LISTING_SOURCE_MAX_CHARACTERS + 1),
    );
    const service = new ListingAssistanceService(aiProvider);

    await expect(service.extractFromAudio(file)).rejects.toThrow(
      PayloadTooLargeException,
    );
    expect(aiProvider.extractFromText).not.toHaveBeenCalled();
  });

  it('uses one Berlin date across AI extraction and deterministic merging', async () => {
    jest.useFakeTimers();
    const beforeMidnight = new Date('2026-01-01T22:59:59.000Z');
    const afterMidnight = new Date('2026-01-01T23:00:01.000Z');
    jest.setSystemTime(beforeMidnight);
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockImplementation((_text, currentDate) => {
      jest.setSystemTime(afterMidnight);
      return Promise.resolve(
        candidate({ availableFrom: toBerlinIsoDate(currentDate) }),
      );
    });
    const service = new ListingAssistanceService(aiProvider);

    try {
      const result = await service.extractFromText('ab sofort');

      expect(result.values.availableFrom).toBe('2026-01-01');
      expect(result.inconsistencies).toEqual([]);
      expect(aiProvider.extractFromText).toHaveBeenCalledWith(
        'ab sofort',
        beforeMidnight,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies deterministic living area when AI returns null', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(candidate({}));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Wohnfläche 100 qm');

    expect(result.values.livingArea).toBe(100);
  });

  it('keeps AI living area when deterministic value matches', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(
      candidate({ livingArea: 100 }),
    );
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('100 m² Wohnfläche');

    expect(result.values.livingArea).toBe(100);
    expect(result.inconsistencies).toEqual([]);
  });

  it('uses unambiguous deterministic living area over AI uncertainty', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      ...candidate({}),
      uncertainFields: ['livingArea'],
    });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('Wohnfläche 100 qm');

    expect(result.values.livingArea).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  it('marks living area as conflicting when AI and deterministic values differ', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(candidate({ livingArea: 80 }));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('100 qm');

    expect(result.values.livingArea).toBeUndefined();
    expect(result.inconsistencies).toContainEqual(
      expect.objectContaining({ field: 'livingArea' }),
    );
  });

  it('applies deterministic availableFrom for immediate availability', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(candidate({}));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('ab sofort');

    expect(result.values.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('applies deterministic availableFrom for unambiguous German date', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(candidate({}));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('verfügbar ab 13.10.2026');

    expect(result.values.availableFrom).toBe('2026-10-13');
  });

  it('marks availableFrom as uncertain for ambiguous dates', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(candidate({}));
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('10/11/2026');

    expect(result.values.availableFrom).toBeUndefined();
    expect(result.warnings).toContainEqual(
      'The source contains an uncertain value for availableFrom',
    );
  });

  it('keeps AI availableFrom when deterministic value matches', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(
      candidate({ availableFrom: '2026-10-13' }),
    );
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('13.10.2026');

    expect(result.values.availableFrom).toBe('2026-10-13');
    expect(result.inconsistencies).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('uses unambiguous deterministic date over AI uncertainty', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue({
      ...candidate({}),
      uncertainFields: ['availableFrom'],
    });
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('13.10.2026');

    expect(result.values.availableFrom).toBe('2026-10-13');
    expect(result.warnings).toEqual([]);
  });

  it('marks availableFrom as conflicting when AI and deterministic values differ', async () => {
    const aiProvider = createProvider();
    aiProvider.extractFromText.mockResolvedValue(
      candidate({ availableFrom: '2026-10-14' }),
    );
    const service = new ListingAssistanceService(aiProvider);

    const result = await service.extractFromText('13.10.2026');

    expect(result.values.availableFrom).toBeUndefined();
    expect(result.inconsistencies).toContainEqual(
      expect.objectContaining({ field: 'availableFrom' }),
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
