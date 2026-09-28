import { describe, expect, it } from '@jest/globals';
import { ApplicationStatus } from '../generated/prisma/enums';
import { ApplicationProcessStateResolver } from './application-process-state.resolver';

describe('ApplicationProcessStateResolver', () => {
  it.each(Object.values(ApplicationStatus))(
    'returns neutral future-process fields for %s',
    (status) => {
      const result = new ApplicationProcessStateResolver().resolve({ status });

      expect(result).toEqual({
        lifecycleStatus: status,
        nextAction: null,
        expectedActor: null,
      });
    },
  );
});
