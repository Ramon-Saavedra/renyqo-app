import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  organizationLegalName,
  requireExpectedRevision,
  requireWorkspaceRevision,
  requireWorkspaceState,
} from './domain/workspace-policy';
import { WorkspaceRepository } from './persistence/workspace.repository';
import { OrganizationProfileRepository } from './persistence/organization-profile.repository';

@Injectable()
export class WorkspaceConversion {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly profiles: OrganizationProfileRepository,
  ) {}

  // Persistence only: same transaction as caller authorization/activation/audit.
  async withinTransaction(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      expectedRevision: number;
      legalName: string | null;
    },
  ) {
    requireExpectedRevision(input.expectedRevision);
    const legalName = organizationLegalName(input.legalName);
    const workspace = await this.workspaces.lock(tx, input.workspaceId);
    requireWorkspaceState(workspace, 'ACTIVE');
    requireWorkspaceRevision(workspace, input.expectedRevision);
    if (workspace.kind !== 'PERSONAL')
      throw new ConflictException('Conversion requires PERSONAL');
    const converted = await this.workspaces.convert(
      tx,
      workspace.id,
      workspace.revision,
    );
    await this.profiles.create(tx, workspace.id, legalName);
    return converted;
  }
}
