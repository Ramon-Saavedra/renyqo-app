import { ConflictException } from '@nestjs/common';
import { translateListingTransferFailure } from './listing-transfer-conflict';

const message = 'Transfer request is stale or ineligible';

describe('Listing transfer integrity failure translation', () => {
  it.each([
    { code: '23514', message },
    {
      code: 'P2004',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '23514', originalMessage: message },
        },
      },
    },
    { cause: { code: '23514', message } },
  ])('maps only the stale-transfer guard to HTTP 409: %j', (error) => {
    expect.assertions(3);
    try {
      translateListingTransferFailure(error);
    } catch (result) {
      expect(result).toBeInstanceOf(ConflictException);
      expect((result as ConflictException).getStatus()).toBe(409);
      expect((result as Error).message).toBe(message);
    }
  });

  it.each([
    { code: '23514', message: 'Lock workspace before transfer request writes' },
    { code: '23505', message },
    { message },
    new Error('Connection failed'),
    null,
  ])('preserves unrelated failures unchanged: %j', (error) => {
    expect.assertions(1);
    try {
      translateListingTransferFailure(error);
    } catch (result) {
      expect(result).toBe(error);
    }
  });
});
