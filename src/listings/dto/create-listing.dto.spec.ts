import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';

import { ObjectType } from '../../generated/prisma/enums';
import { CreateListingDto } from './create-listing.dto';

const validateDto = (payload: Record<string, unknown>) =>
  validate(plainToInstance(CreateListingDto, payload));

describe('CreateListingDto', () => {
  it('allows a partial draft with one listing field', async () => {
    const errors = await validateDto({ title: 'Draft title' });

    expect(errors).toHaveLength(0);
  });

  it('allows an empty payload at DTO level so the service can enforce draft rules', async () => {
    const errors = await validateDto({});

    expect(errors).toHaveLength(0);
  });

  it('rejects empty strings for non-empty text fields when provided', async () => {
    const errors = await validateDto({ city: '' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('city');
  });

  it('rejects invalid optional enum values when provided', async () => {
    const errors = await validateDto({ objectType: 'castle' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('objectType');
  });

  it('accepts valid objectType when provided', async () => {
    const errors = await validateDto({ objectType: ObjectType.APARTMENT });

    expect(errors).toHaveLength(0);
  });

  it('accepts depositMonths values from one to three', async () => {
    await expect(validateDto({ depositMonths: 1 })).resolves.toHaveLength(0);
    await expect(validateDto({ depositMonths: 2 })).resolves.toHaveLength(0);
    await expect(validateDto({ depositMonths: 3 })).resolves.toHaveLength(0);
  });

  it('rejects depositMonths values outside the allowed range', async () => {
    const belowRange = await validateDto({ depositMonths: 0 });
    const aboveRange = await validateDto({ depositMonths: 4 });

    expect(belowRange[0]?.property).toBe('depositMonths');
    expect(aboveRange[0]?.property).toBe('depositMonths');
  });

  it('rejects decimal depositMonths values', async () => {
    const errors = await validateDto({ depositMonths: 1.5 });

    expect(errors[0]?.property).toBe('depositMonths');
  });

  describe('optional eligibility criteria', () => {
    it('accepts omitted eligibility criteria', async () => {
      const errors = await validateDto({ title: 'Draft title' });

      expect(errors).toHaveLength(0);
    });

    it('accepts empty strings and normalizes them to undefined', async () => {
      const instance = plainToInstance(CreateListingDto, {
        minimumHouseholdNetIncome: '',
        suitableForPeopleCount: '',
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.minimumHouseholdNetIncome).toBeUndefined();
      expect(instance.suitableForPeopleCount).toBeUndefined();
    });

    it('accepts whitespace-only strings and normalizes them to undefined', async () => {
      const instance = plainToInstance(CreateListingDto, {
        minimumHouseholdNetIncome: '   ',
        suitableForPeopleCount: '\t ',
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.minimumHouseholdNetIncome).toBeUndefined();
      expect(instance.suitableForPeopleCount).toBeUndefined();
    });

    it('accepts null for eligibility criteria', async () => {
      const instance = plainToInstance(CreateListingDto, {
        minimumHouseholdNetIncome: null,
        suitableForPeopleCount: null,
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.minimumHouseholdNetIncome).toBeNull();
      expect(instance.suitableForPeopleCount).toBeNull();
    });

    it('accepts numeric values', async () => {
      const errors = await validateDto({
        minimumHouseholdNetIncome: 3000,
        suitableForPeopleCount: 2,
      });

      expect(errors).toHaveLength(0);
    });

    it('converts valid numeric strings to numbers', async () => {
      const instance = plainToInstance(CreateListingDto, {
        minimumHouseholdNetIncome: '3000.50',
        suitableForPeopleCount: '2',
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.minimumHouseholdNetIncome).toBe(3000.5);
      expect(instance.suitableForPeopleCount).toBe(2);
    });

    it('accepts an income of zero', async () => {
      const errors = await validateDto({ minimumHouseholdNetIncome: 0 });

      expect(errors).toHaveLength(0);
    });

    it('accepts a people count of one', async () => {
      const errors = await validateDto({ suitableForPeopleCount: 1 });

      expect(errors).toHaveLength(0);
    });

    it('rejects invalid numeric strings', async () => {
      const income = await validateDto({ minimumHouseholdNetIncome: 'abc' });
      const peopleCount = await validateDto({ suitableForPeopleCount: 'abc' });

      expect(income).toHaveLength(1);
      expect(income[0]?.property).toBe('minimumHouseholdNetIncome');
      expect(peopleCount).toHaveLength(1);
      expect(peopleCount[0]?.property).toBe('suitableForPeopleCount');
    });

    it('rejects a negative income', async () => {
      const errors = await validateDto({ minimumHouseholdNetIncome: -1 });

      expect(errors[0]?.property).toBe('minimumHouseholdNetIncome');
      expect(errors[0]?.constraints).toHaveProperty('min');
    });

    it('rejects a negative income sent as a string', async () => {
      const errors = await validateDto({ minimumHouseholdNetIncome: '-1' });

      expect(errors[0]?.property).toBe('minimumHouseholdNetIncome');
      expect(errors[0]?.constraints).toHaveProperty('min');
    });

    it('rejects a people count of zero', async () => {
      const errors = await validateDto({ suitableForPeopleCount: 0 });

      expect(errors[0]?.property).toBe('suitableForPeopleCount');
      expect(errors[0]?.constraints).toHaveProperty('min');
    });

    it('rejects a negative people count', async () => {
      const errors = await validateDto({ suitableForPeopleCount: -2 });

      expect(errors[0]?.property).toBe('suitableForPeopleCount');
      expect(errors[0]?.constraints).toHaveProperty('min');
    });

    it('rejects a decimal people count', async () => {
      const errors = await validateDto({ suitableForPeopleCount: 1.5 });

      expect(errors[0]?.property).toBe('suitableForPeopleCount');
      expect(errors[0]?.constraints).toHaveProperty('isInt');
    });

    it('rejects a decimal people count sent as a string', async () => {
      const errors = await validateDto({ suitableForPeopleCount: '1.5' });

      expect(errors[0]?.property).toBe('suitableForPeopleCount');
      expect(errors[0]?.constraints).toHaveProperty('isInt');
    });
  });
});
