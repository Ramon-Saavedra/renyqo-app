import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';

import { ApplicantListingsQueryDto } from './applicant-listings-query.dto';

const validateDto = (payload: Record<string, unknown>) =>
  validate(plainToInstance(ApplicantListingsQueryDto, payload));

describe('ApplicantListingsQueryDto', () => {
  it('accepts an empty query', async () => {
    const errors = await validateDto({});

    expect(errors).toHaveLength(0);
  });

  it('accepts a valid city filter', async () => {
    const errors = await validateDto({ city: 'Berlin' });

    expect(errors).toHaveLength(0);
  });

  it('accepts valid rent range filters', async () => {
    const errors = await validateDto({ minRent: '500', maxRent: '2000' });

    expect(errors).toHaveLength(0);
  });

  it('accepts valid rooms range filters', async () => {
    const errors = await validateDto({ minRooms: '1', maxRooms: '4' });

    expect(errors).toHaveLength(0);
  });

  it('accepts valid living area range filters', async () => {
    const errors = await validateDto({
      minLivingArea: '20',
      maxLivingArea: '100',
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects negative rent', async () => {
    const errors = await validateDto({ minRent: '-1' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('minRent');
  });

  it('rejects negative rooms', async () => {
    const errors = await validateDto({ minRooms: '-2' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('minRooms');
  });

  it('rejects negative living area', async () => {
    const errors = await validateDto({ minLivingArea: '-10' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('minLivingArea');
  });

  it('rejects limit above maximum', async () => {
    const errors = await validateDto({ limit: '100' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('limit');
  });

  it('rejects limit below minimum', async () => {
    const errors = await validateDto({ limit: '0' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('limit');
  });

  it('rejects invalid cursor value type', async () => {
    const errors = await validateDto({ cursor: 123 });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('cursor');
  });

  it('converts numeric strings to numbers for range filters', async () => {
    const instance = plainToInstance(ApplicantListingsQueryDto, {
      minRent: '800',
      maxRent: '2500',
      minRooms: '2',
      maxRooms: '3',
      minLivingArea: '40',
      maxLivingArea: '80',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.minRent).toBe(800);
    expect(instance.maxRent).toBe(2500);
    expect(instance.minRooms).toBe(2);
    expect(instance.maxRooms).toBe(3);
    expect(instance.minLivingArea).toBe(40);
    expect(instance.maxLivingArea).toBe(80);
  });

  it('defaults limit to 20 when omitted', async () => {
    const instance = plainToInstance(ApplicantListingsQueryDto, {});

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.limit).toBe(20);
  });

  it('converts valid limit string to number', async () => {
    const instance = plainToInstance(ApplicantListingsQueryDto, {
      limit: '10',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
    expect(instance.limit).toBe(10);
  });

  it('accepts a numeric limit', async () => {
    const errors = await validateDto({ limit: 5 });

    expect(errors).toHaveLength(0);
  });

  it('accepts a valid cursor string', async () => {
    const errors = await validateDto({
      cursor: 'eyJwIjoiMjAyNS0wMS0wMSIsImkiOiJ1dWlkIn0',
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects cursor exceeding maximum length', async () => {
    const longCursor = 'x'.repeat(257);

    const errors = await validateDto({ cursor: longCursor });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('cursor');
  });
});
