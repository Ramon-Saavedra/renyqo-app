import { randomUUID } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { AuditedWorkspaceTransactions } from '../src/audit/context/audited-workspace-transactions';
import { HistoricalActorSnapshotCapture } from './historical-actor-snapshot.fixture';
import { AuditContexts } from '../src/audit/context/audit-contexts';
import { AuditSignals } from '../src/audit/observability/audit-signals';
import { AuditQuery } from '../src/audit/queries/audit-query';
import {
  auditCommand,
  type AuditCommand,
} from '../src/audit/commands/audit-command';
import type { RequiredAudit } from '../src/audit/context/required-audit';
import type {
  SessionAuthority,
  HumanAuthority,
} from '../src/provider-authorization/domain/authorization.types';
export function contextCommand(effects = ['activation']): AuditCommand {
  return auditCommand({
    commandId: randomUUID(),
    commandScope: 'audit.ledger.activation',
    correlationId: randomUUID(),
    causationId: randomUUID(),
    requiredEffects: effects,
  });
}
export const effect = (effectKey = 'activation') => ({
  effectKey,
  changes: {},
  metadata: { activationVersion: 1 as const },
});
export class AuditContextFixture extends ListingWorkspaceFixture {
  w!: Awaited<ReturnType<ListingWorkspaceFixture['organization']>>;
  foreign!: typeof this.w;
  owner!: SessionAuthority;
  agent!: SessionAuthority;
  readonly signals = new AuditSignals();
  readonly contexts = new AuditContexts(this.signals);
  override async start() {
    await super.start();
    this.w = await this.organization();
    this.foreign = await this.organization();
    await this.activateApplication();
    this.owner = await this.session(this.w.ownerUser);
    this.agent = await this.session(this.w.agents[0].userId);
    // Isolated test mutation target, not production domain adoption.
    await this.pool.query(
      `GRANT SELECT,INSERT,UPDATE ON authz_test_resources TO "${this.applicationLogin}"`,
    );
  }
  get query() {
    return new AuditQuery(
      this.applicationRuntime as PrismaService,
      this.resolver,
      this.signals,
    );
  }
  get protectedWrites() {
    return this.writeAdapter(this.applicationRuntime as PrismaService);
  }
  // Trusted test-only delegation seam; not the production human runtime login.
  get trustedWrites() {
    return this.writeAdapter(this.prisma as PrismaService);
  }
  private writeAdapter(database: PrismaService) {
    return new AuditedWorkspaceTransactions(
      new ProtectedWorkspaceTransactions(
        database,
        this.authorityLocks,
        this.globalAuthority,
        this.resolver,
        new HistoricalActorSnapshotCapture(),
      ),
    );
  }
  run<T>(
    command: AuditCommand,
    work: (audit: RequiredAudit, tx: Prisma.TransactionClient) => Promise<T>,
    authority: HumanAuthority = this.owner,
  ) {
    return this.protectedWrites.run(
      authority,
      {
        workspaceId: this.w.id,
        action: 'audit.ledger.activated',
        resourceIds: [this.w.id],
        purpose: 'OPERATIONAL',
      },
      { kind: 'BUSINESS' },
      () => Promise.resolve(),
      (tx, ctx) =>
        this.contexts.member(tx, ctx, command, (audit) => work(audit, tx)),
    );
  }
}
