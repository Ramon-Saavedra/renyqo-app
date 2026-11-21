import { Module } from '@nestjs/common';
import { AuditWriter } from './persistence/audit-writer';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { AuditContexts } from './context/audit-contexts';
import { AuditQuery } from './queries/audit-query';
import { AuditSignals } from './observability/audit-signals';
import { AuditedWorkspaceTransactions } from './context/audited-workspace-transactions';

// Explicit internal imports only. AppModule still does not activate adoption.
@Module({
  imports: [ProviderAuthorizationModule],
  providers: [
    AuditWriter,
    AuditContexts,
    AuditQuery,
    AuditSignals,
    AuditedWorkspaceTransactions,
  ],
  exports: [AuditContexts, AuditQuery, AuditedWorkspaceTransactions],
})
export class AuditModule {}
