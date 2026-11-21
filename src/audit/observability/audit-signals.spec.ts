import { Logger } from '@nestjs/common';
import { AuditSignals, type AuditSignal } from './audit-signals';
describe('Audit operational signals', () => {
  it('logs only closed operational signals without audit data', () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      for (const signal of [
        'AUDIT_CONTEXT_MISSING',
        'AUDIT_APPEND_FAILED',
        'AUDIT_ACTOR_INVALID',
        'AUDIT_QUERY_DENIED',
        'AUDIT_PAYLOAD_REJECTED',
      ] as AuditSignal[])
        new AuditSignals().report(signal);
      expect(log.mock.calls.map((call) => call[0] as unknown)).toEqual([
        { signal: 'AUDIT_CONTEXT_MISSING' },
        { signal: 'AUDIT_APPEND_FAILED' },
        { signal: 'AUDIT_ACTOR_INVALID' },
        { signal: 'AUDIT_QUERY_DENIED' },
        { signal: 'AUDIT_PAYLOAD_REJECTED' },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
