import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';

import { UpdateApplicantProfileDto } from './update-applicant-profile.dto';

const validateDto = (payload: Record<string, unknown>) =>
  validate(plainToInstance(UpdateApplicantProfileDto, payload));

describe('UpdateApplicantProfileDto', () => {
  it('accepts a valid partial payload', async () => {
    const errors = await validateDto({
      householdNetIncome: 3000,
      hasPets: false,
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts an empty object at DTO level', async () => {
    const errors = await validateDto({});

    expect(errors).toHaveLength(0);
  });

  it('rejects negative household income', async () => {
    const errors = await validateDto({ householdNetIncome: -1 });

    expect(errors[0]?.property).toBe('householdNetIncome');
    expect(errors[0]?.constraints).toHaveProperty('min');
  });

  it('rejects peopleCount as unknown field', async () => {
    const errors = await validate(
      plainToInstance(UpdateApplicantProfileDto, { peopleCount: 3 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('peopleCount');
  });

  it('accepts valid household counts', async () => {
    const errors = await validateDto({ adultsCount: 2, childrenCount: 1 });

    expect(errors).toHaveLength(0);
  });

  it('rejects adultsCount below 1', async () => {
    const errors = await validateDto({ adultsCount: 0 });

    expect(errors[0]?.property).toBe('adultsCount');
    expect(errors[0]?.constraints).toHaveProperty('min');
  });

  it('accepts childrenCount of zero', async () => {
    const errors = await validateDto({ childrenCount: 0 });

    expect(errors).toHaveLength(0);
  });

  it('accepts nullable smoker answers', async () => {
    const errors = await validateDto({ isSmoker: null });

    expect(errors).toHaveLength(0);
  });

  it.each([
    { input: 'true', expected: true },
    { input: 'false', expected: false },
    { input: true, expected: true },
    { input: false, expected: false },
    { input: null, expected: null },
  ])(
    'transforms isSmoker string "$input" to boolean $expected',
    async ({ input, expected }) => {
      const instance = plainToInstance(UpdateApplicantProfileDto, {
        isSmoker: input,
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.isSmoker).toBe(expected);
    },
  );

  it.each([
    { input: 'true', expected: true },
    { input: 'false', expected: false },
    { input: true, expected: true },
    { input: false, expected: false },
    { input: null, expected: null },
  ])(
    'transforms hasPets string "$input" to boolean $expected',
    async ({ input, expected }) => {
      const instance = plainToInstance(UpdateApplicantProfileDto, {
        hasPets: input,
      });

      await expect(validate(instance)).resolves.toHaveLength(0);
      expect(instance.hasPets).toBe(expected);
    },
  );

  it('rejects ambiguous boolean strings', async () => {
    const instance = plainToInstance(UpdateApplicantProfileDto, {
      isSmoker: 'maybe',
    });

    expect(instance.isSmoker).toBe('maybe');

    const errors = await validate(instance);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('isSmoker');
  });
});
