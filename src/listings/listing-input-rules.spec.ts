import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';

import type { Listing } from '../generated/prisma/client';
import { ListingInputRules } from './listing-input-rules';

const listing = {
  coldRent: 1000,
  depositMonths: 2,
  rooms: 2,
  bedrooms: 1,
} as Listing;

describe('ListingInputRules', () => {
  const rules = new ListingInputRules();

  it('calculates deposits using the exact existing rounding rule', () => {
    expect(rules.calculateDeposit(1234.56, 2)).toBe(2469.12);
  });

  it('builds create data with default deposit months and omits empty values', () => {
    const result = rules.buildCreateData('provider-id', {
      city: ' Berlin ',
      title: '',
      coldRent: 1200,
    });

    expect(result).toMatchObject({
      providerId: 'provider-id',
      city: ' Berlin ',
      coldRent: 1200,
      deposit: 2400,
      depositMonths: 2,
    });
    expect(result).not.toHaveProperty('title');
  });

  it('preserves explicitly cleared eligibility fields on update', () => {
    const result = rules.buildUpdateData(
      {
        minimumHouseholdNetIncome: null,
        title: 'Updated',
      },
      listing,
    );

    expect(result).toMatchObject({
      minimumHouseholdNetIncome: null,
      title: 'Updated',
    });
  });

  it('preserves existing validation errors and messages', () => {
    expect(() => rules.assertDepositMonthsAllowed(4)).toThrow(
      new BadRequestException('depositMonths must be 1, 2, or 3'),
    );
    expect(() => rules.assertDepositMatchesCalculation(1, 2)).toThrow(
      new BadRequestException(
        'deposit must equal coldRent multiplied by depositMonths',
      ),
    );
    expect(() =>
      rules.assertBedroomsNotGreaterThanRooms({
        rooms: 1,
        bedrooms: 2,
      }),
    ).toThrow(
      new BadRequestException('bedrooms must not be greater than rooms'),
    );
  });

  it('recognizes meaningful drafts while ignoring default deposit months', () => {
    expect(rules.hasMeaningfulDraftData({ depositMonths: 2 })).toBe(false);
    expect(rules.hasMeaningfulDraftData({ title: 'Draft' })).toBe(true);
  });
});
