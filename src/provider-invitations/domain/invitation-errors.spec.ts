import { ConflictException } from '@nestjs/common';
import { translateInvitationFailure } from './invitation-errors';
describe('Narrow invitation SQL failure translation', () => {
  it('translates the actual nested Prisma adapter constraint failure', () => {
    expect(() =>
      translateInvitationFailure({
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '23514',
              originalMessage: 'INVITATION_UNAVAILABLE',
            },
          },
        },
      }),
    ).toThrow(ConflictException);
  });
  it('preserves unrelated integrity failures and unexpected errors', () => {
    for (const error of [
      { code: '23514', message: 'Another invariant' },
      new Error('Transport'),
    ]) {
      try {
        translateInvitationFailure(error);
      } catch (found) {
        expect(found).toBe(error);
      }
    }
  });
});
