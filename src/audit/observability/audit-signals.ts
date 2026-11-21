import { Injectable, Logger } from '@nestjs/common';
export type AuditSignal =
  | 'AUDIT_CONTEXT_MISSING'
  | 'AUDIT_APPEND_FAILED'
  | 'AUDIT_ACTOR_INVALID'
  | 'AUDIT_QUERY_DENIED'
  | 'AUDIT_PAYLOAD_REJECTED';
@Injectable()
export class AuditSignals {
  private readonly logger = new Logger(AuditSignals.name);
  report(signal: AuditSignal) {
    // No payloads, actor names, session grants, SQL errors or request bodies.
    this.logger.error({ signal });
  }
}
