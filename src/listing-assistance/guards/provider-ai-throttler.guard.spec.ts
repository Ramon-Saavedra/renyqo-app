import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { getProviderAiTracker } from './provider-ai-throttler.guard';

describe('ProviderAiThrottlerGuard', () => {
  it('uses the authenticated provider ID as its tracker', () => {
    expect(getProviderAiTracker({ user: { id: 'provider-id' } })).toBe(
      'provider:provider-id',
    );
  });

  it('does not fall back to an IP address', () => {
    expect(() => getProviderAiTracker({ ip: '127.0.0.1' })).toThrow(
      UnauthorizedException,
    );
  });
});
