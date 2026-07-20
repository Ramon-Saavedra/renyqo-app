import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from '@jest/globals';

import type { SafeUser } from '../../users/types/safe-user.type';
import { CurrentUser } from './current-user.decorator';

type CustomRouteArgMetadata = {
  index: number;
  factory: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCustomRouteArgMetadata(
  value: unknown,
): value is CustomRouteArgMetadata {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    typeof value.factory === 'function'
  );
}

class TestController {
  getCurrentUser(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }
}

describe('CurrentUser', () => {
  it('returns the authenticated request user from the execution context', () => {
    const metadata: unknown = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      TestController,
      'getCurrentUser',
    );

    expect(isRecord(metadata)).toBe(true);
    const routeArgMetadata = isRecord(metadata)
      ? Object.values(metadata)
          .filter(isCustomRouteArgMetadata)
          .find((value) => value.index === 0)
      : undefined;

    expect(routeArgMetadata).toBeDefined();
    expect(typeof routeArgMetadata?.factory).toBe('function');
  });
});
