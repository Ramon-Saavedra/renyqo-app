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
});
