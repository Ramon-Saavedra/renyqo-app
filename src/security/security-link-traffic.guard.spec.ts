import { HttpException, type ExecutionContext } from '@nestjs/common';
import { SecurityLinkTrafficGuard } from './security-link-traffic.guard';
describe('Bounded security-link attempt limiter', () => {
  const context = (id = 'actor') =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '127.0.0.1',
          path: '/workspace-invitations/accept',
          user: { id },
        }),
      }),
    }) as unknown as ExecutionContext;
  it('fails closed at the bound and expires buckets without timers or listeners', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    try {
      const guard = new SecurityLinkTrafficGuard();
      for (let n = 0; n < 30; n++)
        expect(guard.canActivate(context())).toBe(true);
      expect(() => guard.canActivate(context())).toThrow(HttpException);
      expect(guard.canActivate(context('other'))).toBe(true);
      jest.setSystemTime(new Date('2026-11-17T00:01:00Z'));
      expect(guard.canActivate(context())).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
