import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditEventInput } from '../domain/audit-event';
import { validateAuditEvent } from '../payload/audit-payload';

// Private persistence primitive, not authority or a protected transaction API.
// Runtime has no EXECUTE grant: future adoption must supply a reviewed adapter.
@Injectable()
export class AuditWriter {
  async append(tx: Prisma.TransactionClient, input: AuditEventInput) {
    const envelope = JSON.stringify(validateAuditEvent(input));
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT append_audit_event(${envelope}::jsonb) AS id`;
    return row;
  }
}
