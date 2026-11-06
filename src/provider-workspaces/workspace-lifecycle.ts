import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  requireWorkspaceRevision,
  requireExpectedRevision,
  requireWorkspaceState,
} from './domain/workspace-policy';
import { WorkspaceRepository } from './persistence/workspace.repository';

@Injectable()
export class WorkspaceLifecycle {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  async beginClosingWithinTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    expectedRevision: number,
  ) {
    requireExpectedRevision(expectedRevision);
    const workspace = await this.workspaces.lock(tx, id);
    if (
      workspace.lifecycleStatus === 'CLOSING' &&
      workspace.revision === expectedRevision + 1
    )
      return workspace;
    requireWorkspaceRevision(workspace, expectedRevision);
    requireWorkspaceState(workspace, 'ACTIVE');
    return this.workspaces.beginClosing(tx, id, expectedRevision);
  }

  // Only a future closure coordinator may call this after all cross-domain
  // settlement. This class neither claims nor fabricates that settlement.
  async completeClosureWithinTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    expectedRevision: number,
  ) {
    requireExpectedRevision(expectedRevision);
    const workspace = await this.workspaces.lock(tx, id);
    if (
      workspace.lifecycleStatus === 'CLOSED' &&
      workspace.revision === expectedRevision + 1
    )
      return workspace;
    requireWorkspaceRevision(workspace, expectedRevision);
    requireWorkspaceState(workspace, 'CLOSING');
    return this.workspaces.completeClosure(tx, id, expectedRevision);
  }
}
