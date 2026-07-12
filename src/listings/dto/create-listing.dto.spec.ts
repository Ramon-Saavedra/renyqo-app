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
});
