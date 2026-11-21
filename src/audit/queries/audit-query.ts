import {
  Injectable,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceMembershipResolver } from '../../provider-authorization/workspace-membership.resolver';
import type { SessionAuthority } from '../../provider-authorization/domain/authorization.types';
import { AuditSignals } from '../observability/audit-signals';
import {
  auditPage,
  type AuditPageInput,
  type AuditProjection,
} from './audit-page';

@Injectable()
export class AuditQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly signals: AuditSignals,
  ) {}
  async page(
    authority: SessionAuthority,
    workspaceId: string,
    input: AuditPageInput,
  ) {
    const page = auditPage(input);
    const requirement = {
      workspaceId,
      action: 'audit.read',
      resourceIds: [],
      requiredRole: 'OWNER' as const,
      purpose: 'HISTORY' as const,
    };
    try {
      const result = await this.resolver.read(
        this.prisma,
        authority,
        requirement,
        async (context, tx) => {
          const rows = await tx.$queryRaw<{ event: AuditProjection }[]>`
          SELECT event FROM query_workspace_audit(${context.workspaceId}::uuid,${context.userId}::uuid,
            ${authority.sessionId},${context.authVersion},${page.limit + 1},
            ${page.before?.recordedAt ?? null}::timestamptz,${page.before?.id ?? null}::uuid)`;
          return {
            rows: rows.map((row) => row.event),
            revision: context.membershipRevision,
          };
        },
      );
      // Revalidate role/revision after the bounded query; never return a cached
      // page after intervening revocation. No long-lived locking transaction.
      await this.resolver.read(
        this.prisma,
        authority,
        { ...requirement, expectedMembershipRevision: result.revision },
        () => Promise.resolve(),
      );
      const rows = result.rows.slice(0, page.limit),
        last = rows.at(-1);
      return {
        rows,
        next:
          result.rows.length > page.limit && last
            ? {
                recordedAt: new Date(last.recordedAt).toISOString(),
                id: last.id,
              }
            : null,
      };
    } catch (error) {
      this.signals.report('AUDIT_QUERY_DENIED');
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Audit query unavailable');
    }
  }
}
