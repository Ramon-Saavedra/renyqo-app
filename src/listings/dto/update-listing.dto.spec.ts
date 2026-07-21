import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';

import { UpdateListingDto } from './update-listing.dto';

const validateDto = (payload: Record<string, unknown>) =>
  validate(plainToInstance(UpdateListingDto, payload));

describe('UpdateListingDto', () => {
  it('accepts a payload without eligibility criteria', async () => {
    const instance = plainToInstance(UpdateListingDto, { title: 'Updated' });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minimumHouseholdNetIncome).toBeUndefined();
    expect(instance.suitableForPeopleCount).toBeUndefined();
  });

  it('accepts empty strings and normalizes them to undefined', async () => {
    const instance = plainToInstance(UpdateListingDto, {
      minimumHouseholdNetIncome: '',
      suitableForPeopleCount: '',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minimumHouseholdNetIncome).toBeUndefined();
    expect(instance.suitableForPeopleCount).toBeUndefined();
  });

  it('accepts whitespace-only strings and normalizes them to undefined', async () => {
    const instance = plainToInstance(UpdateListingDto, {
      minimumHouseholdNetIncome: '  ',
      suitableForPeopleCount: ' \t',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minimumHouseholdNetIncome).toBeUndefined();
    expect(instance.suitableForPeopleCount).toBeUndefined();
  });

  it('keeps null so the service can clear the criteria', async () => {
    const instance = plainToInstance(UpdateListingDto, {
      minimumHouseholdNetIncome: null,
      suitableForPeopleCount: null,
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minimumHouseholdNetIncome).toBeNull();
    expect(instance.suitableForPeopleCount).toBeNull();
  });

  it('converts valid numeric strings to numbers', async () => {
    const instance = plainToInstance(UpdateListingDto, {
      minimumHouseholdNetIncome: '2500',
      suitableForPeopleCount: '3',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minimumHouseholdNetIncome).toBe(2500);
    expect(instance.suitableForPeopleCount).toBe(3);
  });

  it('accepts boundary values', async () => {
    const errors = await validateDto({
      minimumHouseholdNetIncome: 0,
      suitableForPeopleCount: 1,
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects invalid numeric strings', async () => {
    const income = await validateDto({ minimumHouseholdNetIncome: 'abc' });
    const peopleCount = await validateDto({ suitableForPeopleCount: 'abc' });

    expect(income[0]?.property).toBe('minimumHouseholdNetIncome');
    expect(peopleCount[0]?.property).toBe('suitableForPeopleCount');
  });

  it('rejects a negative income', async () => {
    const errors = await validateDto({ minimumHouseholdNetIncome: -1 });

    expect(errors[0]?.property).toBe('minimumHouseholdNetIncome');
    expect(errors[0]?.constraints).toHaveProperty('min');
  });

  it('rejects zero, negative and decimal people counts', async () => {
    const zero = await validateDto({ suitableForPeopleCount: 0 });
    const negative = await validateDto({ suitableForPeopleCount: -2 });
    const decimal = await validateDto({ suitableForPeopleCount: 1.5 });

    expect(zero[0]?.constraints).toHaveProperty('min');
    expect(negative[0]?.constraints).toHaveProperty('min');
    expect(decimal[0]?.constraints).toHaveProperty('isInt');
  });
});
