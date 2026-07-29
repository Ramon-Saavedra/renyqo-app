import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';

import { SmokingStatus } from '../../generated/prisma/enums';
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

  it('normalizes empty petsNote to null', () => {
    const instance = plainToInstance(UpdateApplicantProfileDto, {
      petsNote: '',
    });

    expect(instance.petsNote).toBeNull();
  });

  it('normalizes whitespace-only petsNote to null', () => {
    const instance = plainToInstance(UpdateApplicantProfileDto, {
      petsNote: '   ',
    });

    expect(instance.petsNote).toBeNull();
  });

  it('preserves non-blank petsNote', () => {
    const instance = plainToInstance(UpdateApplicantProfileDto, {
      petsNote: 'Two cats',
    });

    expect(instance.petsNote).toBe('Two cats');
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

  it('accepts null petsNote', async () => {
    const instance = plainToInstance(UpdateApplicantProfileDto, {
      petsNote: null,
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.petsNote).toBeNull();
  });

  it('accepts valid smoking status', async () => {
    const errors = await validateDto({
      smokingStatus: SmokingStatus.NON_SMOKER,
    });

    expect(errors).toHaveLength(0);
  });
});
